// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BhashaRegistry} from "../contracts/BhashaRegistry.sol";
import {BhashaSettlement} from "../contracts/BhashaSettlement.sol";
import {AgentSpendPolicy} from "../contracts/AgentSpendPolicy.sol";

interface Vm {
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function assume(bool) external;
}

contract MockUSDT is IERC20 {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    uint256 public override totalSupply;

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        uint256 permitted = allowance[from][msg.sender];
        require(permitted >= amount, "allowance");
        if (permitted != type(uint256).max) allowance[from][msg.sender] = permitted - amount;
        _transfer(from, to, amount);
        return true;
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata
    ) external {
        require(block.timestamp > validAfter && block.timestamp < validBefore, "authorization expired");
        require(!authorizationState[from][nonce], "authorization used");
        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

contract BhashaSettlementTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant PAYER = address(0xA11CE);
    address private constant MERCHANT = address(0xB0B);
    address private constant DENIED_RELAYER = address(0xBAD);
    bytes32 private constant SERVICE_ID = keccak256("translate");

    MockUSDT private token;
    BhashaRegistry private registry;
    BhashaSettlement private settlement;

    function setUp() public {
        vm.warp(100);
        token = new MockUSDT();
        registry = new BhashaRegistry(address(this));
        vm.prank(MERCHANT);
        registry.registerService(SERVICE_ID, 100, "ipfs://translation");
        settlement = new BhashaSettlement(address(token), address(registry), address(this), 1_000_000, address(this));
        token.mint(PAYER, 1_000_000);
    }

    function testHappyPathStoresReceiptAndTransfersExactPrice() public {
        bytes32 requestHash = keccak256("request-1");
        uint256 receiptId = _settle(SERVICE_ID, PAYER, 100, requestHash, keccak256("nonce-1"));
        BhashaSettlement.Receipt memory receipt = settlement.getReceipt(receiptId);

        require(receipt.serviceId == SERVICE_ID, "service");
        require(receipt.payer == PAYER, "payer");
        require(receipt.merchant == MERCHANT, "merchant");
        require(receipt.amount == 100, "amount");
        require(receipt.timestamp == 100, "timestamp");
        require(receipt.requestHash == requestHash, "request hash");
        require(token.balanceOf(MERCHANT) == 100, "merchant paid");
    }

    function testReplayRejected() public {
        bytes32 requestHash = keccak256("request-replay");
        _settle(SERVICE_ID, PAYER, 100, requestHash, keccak256("nonce-2"));
        vm.expectRevert(BhashaSettlement.RequestAlreadySettled.selector);
        _settle(SERVICE_ID, PAYER, 100, requestHash, keccak256("nonce-3"));
    }

    function testWrongAmountRejected() public {
        vm.expectRevert(BhashaSettlement.AmountMismatch.selector);
        _settle(SERVICE_ID, PAYER, 101, keccak256("wrong-amount"), keccak256("nonce-4"));
    }

    function testInactiveServiceRejected() public {
        vm.prank(MERCHANT);
        registry.setActive(SERVICE_ID, false);
        vm.expectRevert(BhashaSettlement.ServiceInactive.selector);
        _settle(SERVICE_ID, PAYER, 100, keccak256("inactive"), keccak256("nonce-5"));
    }

    function testNonAllowlistedRelayerRejected() public {
        vm.prank(DENIED_RELAYER);
        vm.expectRevert(BhashaSettlement.RelayerNotAllowed.selector);
        settlement.settle(
            SERVICE_ID,
            PAYER,
            100,
            0,
            type(uint256).max,
            keccak256("nonce-6"),
            "",
            keccak256("denied-relayer")
        );
    }

    function testOverBudgetRejected() public {
        AgentSpendPolicy policy = _attachPolicy(99, 100, 100);
        vm.prank(PAYER);
        policy.setMerchantAllowed(MERCHANT, true);
        vm.expectRevert(AgentSpendPolicy.TotalBudgetExceeded.selector);
        _settle(SERVICE_ID, PAYER, 100, keccak256("over-budget"), keccak256("nonce-7"));
    }

    function testPerMerchantLimitRejected() public {
        AgentSpendPolicy policy = _attachPolicy(500, 99, 100);
        vm.prank(PAYER);
        policy.setMerchantAllowed(MERCHANT, true);
        vm.expectRevert(AgentSpendPolicy.MerchantLimitExceeded.selector);
        _settle(SERVICE_ID, PAYER, 100, keccak256("merchant-limit"), keccak256("nonce-8"));
    }

    function testApprovalThresholdRequiresAndConsumesApproval() public {
        AgentSpendPolicy policy = _attachPolicy(500, 500, 50);
        vm.prank(PAYER);
        policy.setMerchantAllowed(MERCHANT, true);
        bytes32 requestHash = keccak256("approval");
        vm.expectRevert(AgentSpendPolicy.ApprovalRequired.selector);
        _settle(SERVICE_ID, PAYER, 100, requestHash, keccak256("nonce-9"));

        vm.prank(PAYER);
        policy.approveRequest(requestHash);
        _settle(SERVICE_ID, PAYER, 100, requestHash, keccak256("nonce-10"));
        require(!policy.approvedRequests(requestHash), "approval consumed");
    }

    function testMerchantCanRefundOnlyOnce() public {
        uint256 receiptId = _settle(
            SERVICE_ID,
            PAYER,
            100,
            keccak256("refund"),
            keccak256("nonce-11")
        );
        vm.prank(MERCHANT);
        token.approve(address(settlement), 100);
        vm.prank(MERCHANT);
        settlement.refund(receiptId);
        require(token.balanceOf(PAYER) == 1_000_000, "payer refunded");

        vm.prank(MERCHANT);
        vm.expectRevert(BhashaSettlement.AlreadyRefunded.selector);
        settlement.refund(receiptId);
    }

    function testPausedSettlementRejected() public {
        settlement.pause();
        vm.expectRevert();
        _settle(SERVICE_ID, PAYER, 100, keccak256("paused"), keccak256("nonce-12"));
    }

    function testFuzz_ExactRegisteredAmount(uint256 amount) public {
        vm.assume(amount > 0 && amount <= 1e24);
        bytes32 serviceId = keccak256(abi.encode("fuzz-service", amount));
        vm.prank(MERCHANT);
        registry.registerService(serviceId, amount, "ipfs://fuzz");
        settlement.setMaxAmountPerSettlement(amount);
        token.mint(PAYER, amount);
        _settle(serviceId, PAYER, amount, keccak256(abi.encode("fuzz-request", amount)), bytes32(amount));
        require(token.balanceOf(MERCHANT) == amount, "fuzz exact transfer");
    }

    function testFuzz_BudgetBoundary(uint96 rawBudget) public {
        uint256 budget = uint256(rawBudget);
        AgentSpendPolicy policy = _attachPolicy(budget, type(uint256).max, type(uint256).max);
        vm.prank(PAYER);
        policy.setMerchantAllowed(MERCHANT, true);

        if (budget < 100) {
            vm.expectRevert(AgentSpendPolicy.TotalBudgetExceeded.selector);
            _settle(SERVICE_ID, PAYER, 100, keccak256("fuzz-under-budget"), bytes32(uint256(13)));
        } else {
            _settle(SERVICE_ID, PAYER, 100, keccak256("fuzz-within-budget"), bytes32(uint256(14)));
            require(policy.totalSpent() == 100, "budget accounted");
        }
    }

    function _attachPolicy(uint256 budget, uint256 merchantLimit, uint256 threshold)
        private
        returns (AgentSpendPolicy policy)
    {
        policy = new AgentSpendPolicy(address(settlement), PAYER);
        vm.prank(PAYER);
        policy.configure(budget, merchantLimit, threshold);
        vm.prank(PAYER);
        settlement.setSpendPolicy(address(policy));
    }

    function _settle(bytes32 serviceId, address payer, uint256 amount, bytes32 requestHash, bytes32 nonce)
        private
        returns (uint256)
    {
        return settlement.settle(
            serviceId,
            payer,
            amount,
            0,
            type(uint256).max,
            nonce,
            "",
            requestHash
        );
    }
}
