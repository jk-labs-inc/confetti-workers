import { base64url } from "jose";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { createSiweMessage } from "viem/siwe";
import { mintParaJwt, type ParaWalletFixture } from "../fakes/para";
import { TEST_APP_ORIGIN } from "./bindings";

export const encodeProof = (proof: unknown): string => base64url.encode(JSON.stringify(proof));

export const randomAccount = (): PrivateKeyAccount => privateKeyToAccount(generatePrivateKey());

export const randomAddress = (): string => randomAccount().address;

export const paraProof = async (
  address: string,
  options: { wallets?: ParaWalletFixture[]; audience?: string; expiresAt?: number } = {},
): Promise<string> =>
  encodeProof({
    kind: "para",
    address,
    jwt: await mintParaJwt({
      wallets: options.wallets ?? [{ type: "EVM", address: address.toLowerCase() }],
      audience: options.audience,
      expiresAt: options.expiresAt,
    }),
  });

export interface SiweOptions {
  domain?: string;
  uri?: string;
  chainId?: number;
  expirationTime?: Date | null;
  signer?: PrivateKeyAccount;
}

export const siweProof = async (
  account: PrivateKeyAccount,
  nonce: string,
  options: SiweOptions = {},
): Promise<string> => {
  const uri = options.uri ?? TEST_APP_ORIGIN;
  const message = createSiweMessage({
    address: account.address,
    chainId: options.chainId ?? polygon.id,
    domain: options.domain ?? new URL(uri).host,
    nonce,
    uri,
    version: "1",
    statement: "Prove you own this wallet to claim on Confetti.",
    issuedAt: new Date(),
    expirationTime:
      options.expirationTime === null ? undefined : (options.expirationTime ?? new Date(Date.now() + 600_000)),
  });
  const signature = await (options.signer ?? account).signMessage({ message });
  return encodeProof({ kind: "siwe", message, signature });
};
