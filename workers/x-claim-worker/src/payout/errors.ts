import { BaseError } from "viem";
import type { PayoutErrorCode } from "./types";

export const loggableErrorText = (error: unknown): string =>
  error instanceof BaseError ? `${error.name}: ${error.shortMessage} ${error.details}` : String(error);

export class PayoutError extends Error {
  constructor(
    readonly code: PayoutErrorCode,
    message: string,
  ) {
    super(message);
  }
}
