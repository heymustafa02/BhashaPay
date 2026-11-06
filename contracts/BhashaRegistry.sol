// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract BhashaRegistry is Ownable {
    struct Service {
        bytes32 serviceId;
        address merchant;
        uint256 price;
        string metadataURI;
        bool active;
    }

    mapping(bytes32 => Service) private services;
    bytes32[] private serviceIds;

    error InvalidServiceId();
    error InvalidMerchant();
    error InvalidPrice();
    error ServiceAlreadyRegistered();
    error ServiceNotFound();
    error NotServiceOwner();

    event ServiceRegistered(bytes32 indexed serviceId, address indexed merchant, uint256 price, string metadataURI);
    event ServicePriceUpdated(bytes32 indexed serviceId, uint256 oldPrice, uint256 newPrice);
    event ServiceStatusUpdated(bytes32 indexed serviceId, bool active);
    event ServiceMetadataUpdated(bytes32 indexed serviceId, string metadataURI);

    constructor(address owner_) Ownable(owner_) {}

    function registerService(bytes32 serviceId, uint256 price, string calldata metadataURI) external {
        if (serviceId == bytes32(0)) revert InvalidServiceId();
        if (msg.sender == address(0)) revert InvalidMerchant();
        if (price == 0) revert InvalidPrice();
        if (services[serviceId].merchant != address(0)) revert ServiceAlreadyRegistered();

        services[serviceId] = Service(serviceId, msg.sender, price, metadataURI, true);
        serviceIds.push(serviceId);
        emit ServiceRegistered(serviceId, msg.sender, price, metadataURI);
    }

    function updatePrice(bytes32 serviceId, uint256 price) external {
        Service storage service = _authorizedService(serviceId);
        if (price == 0) revert InvalidPrice();
        uint256 oldPrice = service.price;
        service.price = price;
        emit ServicePriceUpdated(serviceId, oldPrice, price);
    }

    function setActive(bytes32 serviceId, bool active) external {
        Service storage service = _authorizedService(serviceId);
        service.active = active;
        emit ServiceStatusUpdated(serviceId, active);
    }

    function updateMetadata(bytes32 serviceId, string calldata metadataURI) external {
        Service storage service = _authorizedService(serviceId);
        service.metadataURI = metadataURI;
        emit ServiceMetadataUpdated(serviceId, metadataURI);
    }

    function getService(bytes32 serviceId) external view returns (Service memory) {
        Service memory service = services[serviceId];
        if (service.merchant == address(0)) revert ServiceNotFound();
        return service;
    }

    function listServices() external view returns (Service[] memory result) {
        result = new Service[](serviceIds.length);
        for (uint256 i = 0; i < serviceIds.length; ++i) {
            result[i] = services[serviceIds[i]];
        }
    }

    function serviceCount() external view returns (uint256) {
        return serviceIds.length;
    }

    function _authorizedService(bytes32 serviceId) private view returns (Service storage service) {
        service = services[serviceId];
        if (service.merchant == address(0)) revert ServiceNotFound();
        if (msg.sender != owner() && msg.sender != service.merchant) revert NotServiceOwner();
    }
}
