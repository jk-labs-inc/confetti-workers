import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { ClaimCoordinator, coordinatorStub } from "../../src/claims/claimCoordinator";
import type { ClaimOutcome, MaintenanceReport } from "../../src/claims/types";
import { readSettings } from "../../src/config/settings";
import { currentFees, payoutChain, signTransfer } from "../../src/payout/chain";
import { PayoutLedger } from "../../src/payout/ledger";
import type { SocialLinkRow } from "../../src/supabase/types";
import { ALCHEMY_ORIGIN, FakeAlchemy } from "../fakes/alchemy";
import { FakeChain } from "../fakes/chain";
import { FakePara, PARA_BETA_ORIGIN } from "../fakes/para";
import { FakePostgrest, type Row } from "../fakes/postgrest";
import { FakeX, X_API_ORIGIN } from "../fakes/xApi";
import {
  TEST_ALCHEMY_KEY,
  TEST_DAILY_LIMIT,
  TEST_PAYOUT_PRIVATE_KEY,
  TEST_RPC_URL,
  TEST_SUPABASE_KEY,
  TEST_SUPABASE_URL,
} from "./bindings";
import { envWith, useFakeNetwork, type EnvOverrides, type FakeNetwork } from "./harness";
import { randomAddress } from "./proofs";

export const PAYOUT_ADDRESS = privateKeyToAccount(TEST_PAYOUT_PRIVATE_KEY).address.toLowerCase();
const PAYOUT_WALLET_FUNDING = parseEther("1000");

export interface ClaimNetwork {
  network: FakeNetwork;
  postgrest: FakePostgrest;
  x: FakeX;
  chain: FakeChain;
  alchemy: FakeAlchemy;
}

export const useClaimNetwork = (): ClaimNetwork => {
  const fakes = {} as ClaimNetwork;
  fakes.network = useFakeNetwork((network) => {
    fakes.postgrest = new FakePostgrest(TEST_SUPABASE_KEY);
    fakes.x = new FakeX();
    fakes.chain = new FakeChain(polygon.id);
    fakes.alchemy = new FakeAlchemy(TEST_ALCHEMY_KEY);
    fakes.chain.fund(PAYOUT_ADDRESS, PAYOUT_WALLET_FUNDING);
    network.route(TEST_SUPABASE_URL, fakes.postgrest.handle);
    network.route(X_API_ORIGIN, fakes.x.handle);
    network.route(PARA_BETA_ORIGIN, new FakePara().handle);
    network.route(TEST_RPC_URL, fakes.chain.handle);
    network.route(ALCHEMY_ORIGIN, fakes.alchemy.handle);
  });
  return fakes;
};

const eligibleLink = (overrides: Partial<SocialLinkRow> = {}): Row => ({
  address: randomAddress().toLowerCase(),
  platform_user_id: String(Math.floor(Math.random() * 1e15)),
  handle: "eligible",
  verified: true,
  verified_type: "blue",
  is_identity_verified: false,
  subscription_type: "Premium",
  verified_followers_count: 3,
  followers_count: 400,
  following_count: 300,
  post_count: 1200,
  account_created_at: "2015-03-01T12:00:00.000Z",
  ...overrides,
});

export const seedLink = (postgrest: FakePostgrest, overrides: Partial<SocialLinkRow> = {}): SocialLinkRow =>
  postgrest.seed("social_links", eligibleLink(overrides)) as unknown as SocialLinkRow;

export const fillTodaysSpots = (postgrest: FakePostgrest): Row[] =>
  Array.from({ length: TEST_DAILY_LIMIT }, (_, index) =>
    postgrest.seed("claims_history", { address: randomAddress(), platform_user_id: `used-${index}`, status: "paid" }),
  );

export const claimFor = (link: SocialLinkRow): Promise<ClaimOutcome> => coordinatorStub(env).claim(link);

export const claimWithSettings = (overrides: EnvOverrides, link: SocialLinkRow): Promise<ClaimOutcome> =>
  runInDurableObject(coordinatorStub(env), (_, state) => new ClaimCoordinator(state, envWith(overrides)).claim(link));

export const runMaintenance = (): Promise<MaintenanceReport> => coordinatorStub(env).runMaintenance();

export const ageLedger = (claimId: string, ageMs: number): Promise<void> =>
  runInDurableObject(coordinatorStub(env), (_, state) => {
    const then = Date.now() - ageMs;
    state.storage.sql.exec(
      "UPDATE payouts SET nonce_consumed_seen_at = ? WHERE claim_id = ? AND nonce_consumed_seen_at IS NOT NULL",
      then,
      claimId,
    );
    state.storage.sql.exec("UPDATE payout_attempts SET created_at = ? WHERE claim_id = ?", then, claimId);
  });

export const ledgerRows = (): Promise<Record<string, SqlStorageValue>[]> =>
  runInDurableObject(coordinatorStub(env), (_, state) =>
    state.storage.sql.exec("SELECT * FROM payouts ORDER BY nonce").toArray(),
  );

export const ledgerAttempts = (): Promise<Record<string, SqlStorageValue>[]> =>
  runInDurableObject(coordinatorStub(env), (_, state) =>
    state.storage.sql.exec("SELECT * FROM payout_attempts ORDER BY created_at, rowid").toArray(),
  );

export const writeCrashedReservation = (claimId: string, recipient: Hex, nonce: number): Promise<void> =>
  runInDurableObject(coordinatorStub(env), async (_, state) => {
    const chain = payoutChain(readSettings(env).payout);
    const valueWei = parseEther("20");
    const transfer = await signTransfer(chain, { recipient, valueWei, nonce }, await currentFees(chain));
    new PayoutLedger(state.storage).recordSigned(claimId, recipient, valueWei, transfer, Date.now());
  });
