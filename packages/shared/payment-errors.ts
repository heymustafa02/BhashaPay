export type SettledPayment = {
  txHash: string;
  explorerUrl: string;
  receiptId: string;
  payer: string;
  receipt: unknown;
};

export class PaymentSettledActionError extends Error {
  constructor(
    message: string,
    readonly payment: SettledPayment,
  ) {
    super(message);
    this.name = "PaymentSettledActionError";
  }
}
