import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair } from "jose";
import { polygon } from "viem/chains";
import { describe, expect, it } from "vitest";
import { readSettings } from "../../src/config/settings";
import { WALLET_PROOF_HEADER } from "../../src/walletProof/constants";
import { ProofUnavailableError, WalletProofError } from "../../src/walletProof/errors";
import { issueWalletNonce } from "../../src/walletProof/siwe";
import { verifyWalletProof } from "../../src/walletProof/verify";
import { FakeChain } from "../fakes/chain";
import { FakePara, mintParaJwt, PARA_BETA_ORIGIN, PARA_PROD_ORIGIN } from "../fakes/para";
import { TEST_RPC_URL } from "../support/bindings";
import { envWith, useFakeNetwork, type EnvOverrides } from "../support/harness";
import { encodeProof, paraProof, randomAccount, randomAddress, siweProof, type SiweOptions } from "../support/proofs";

let para: FakePara;
let unavailablePara: FakePara;
useFakeNetwork((network) => {
  para = new FakePara();
  unavailablePara = new FakePara();
  unavailablePara.jwksStatus = 503;
  network.route(PARA_BETA_ORIGIN, para.handle);
  network.route(PARA_PROD_ORIGIN, unavailablePara.handle);
  network.route(TEST_RPC_URL, new FakeChain(polygon.id).handle);
});

const verify = (proofHeader: string | null, overrides: EnvOverrides = {}) => {
  const headers = new Headers();
  if (proofHeader !== null) headers.set(WALLET_PROOF_HEADER, proofHeader);
  return verifyWalletProof(
    new Request("https://worker.test/claim", { headers }),
    env,
    readSettings(envWith(overrides)),
  );
};

const signerWithNonce = async () => ({ account: randomAccount(), nonce: (await issueWalletNonce(env)).nonce });

describe("Para session proof", () => {
  it("returns the lowercase wallet address the token carries", async () => {
    const address = randomAddress();

    await expect(verify(await paraProof(address))).resolves.toBe(address.toLowerCase());
  });

  it.each([
    ["issued for another Para app", { audience: "other-app" }],
    ["that has expired", { expiresAt: Math.floor(Date.now() / 1000) - 60 }],
  ])("rejects a token %s", async (_, options) => {
    await expect(verify(await paraProof(randomAddress(), options))).rejects.toThrow(WalletProofError);
  });

  it("rejects an address the token does not carry", async () => {
    const proof = await paraProof(randomAddress(), {
      wallets: [{ type: "EVM", address: randomAddress().toLowerCase() }],
    });

    await expect(verify(proof)).rejects.toThrow("does not include this wallet");
  });

  it("ignores wallets that are not EVM wallets", async () => {
    const address = randomAddress();
    const proof = await paraProof(address, { wallets: [{ type: "SOLANA", address }] });

    await expect(verify(proof)).rejects.toThrow("does not include this wallet");
  });

  it("rejects a token signed by a key Para did not publish", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const address = randomAddress();
    const jwt = await mintParaJwt({
      wallets: [{ type: "EVM", address: address.toLowerCase() }],
      signingKey: await exportJWK(privateKey),
    });

    await expect(verify(encodeProof({ kind: "para", address, jwt }))).rejects.toThrow(
      WalletProofError,
    );
  });

  it("reports Para's key set being down as unavailable, not invalid", async () => {
    const address = randomAddress();

    await expect(verify(await paraProof(address), { PARA_ENVIRONMENT: "PROD" })).rejects.toThrow(
      ProofUnavailableError,
    );
  });
});

describe("signed message proof", () => {
  it("returns the signer's lowercase address and burns the nonce", async () => {
    const { account, nonce } = await signerWithNonce();
    const proof = await siweProof(account, nonce);

    await expect(verify(proof)).resolves.toBe(account.address.toLowerCase());
    await expect(verify(proof)).rejects.toThrow("nonce is unknown, used or expired");
  });

  it("rejects a nonce the worker never issued", async () => {
    const account = randomAccount();

    await expect(verify(await siweProof(account, "neverissued123"))).rejects.toThrow(
      "nonce is unknown, used or expired",
    );
  });

  it.each<[string, SiweOptions, string]>([
    ["for a site that is not allowed", { uri: "https://evil.test" }, "allowed uri"],
    ["whose domain does not match the uri", { domain: "evil.test" }, "domain does not match"],
    ["for another chain", { chainId: 1 }, `chain ID ${polygon.id}`],
    ["without an expiration time", { expirationTime: null }, "expiration time"],
    ["that has expired", { expirationTime: new Date(Date.now() - 1000) }, "expired or not yet valid"],
  ])("rejects a message %s", async (_, options, reason) => {
    const { account, nonce } = await signerWithNonce();

    await expect(verify(await siweProof(account, nonce, options))).rejects.toThrow(reason);
  });

  it("rejects a signature from another key without burning the nonce", async () => {
    const { account, nonce } = await signerWithNonce();
    const impostor = randomAccount();

    await expect(verify(await siweProof(account, nonce, { signer: impostor }))).rejects.toThrow(
      "signature is invalid",
    );
    await expect(verify(await siweProof(account, nonce))).resolves.toBe(account.address.toLowerCase());
  });
});

describe("proof header", () => {
  it.each([
    ["missing", null],
    ["not base64 JSON", "%%%"],
    ["an unknown kind", encodeProof({ kind: "magic" })],
    ["a para proof without an address", encodeProof({ kind: "para", jwt: "x" })],
    ["a siwe proof with a non-hex signature", encodeProof({ kind: "siwe", message: "m", signature: "nope" })],
  ])("rejects a header that is %s", async (_, header) => {
    await expect(verify(header)).rejects.toThrow(WalletProofError);
  });
});
