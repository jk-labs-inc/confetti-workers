export type Row = Record<string, unknown>;

interface UniqueIndex {
  name: string;
  columns: string[];
  where?: (row: Row) => boolean;
}

interface TableDefinition {
  defaults: () => Row;
  uniqueIndexes: UniqueIndex[];
  updatableColumns: Set<string>;
  insertCheck: (row: Row) => boolean;
  updateUsing: (row: Row) => boolean;
  updateCheck: (row: Row) => boolean;
}

const ACTIVE_STATUSES = new Set(["pending", "paid"]);
const INSERTABLE_CLAIM_STATUSES = new Set(["pending", "failed", "rejected"]);
const SETTLED_CLAIM_STATUSES = new Set(["paid", "failed"]);
const anyRow = () => true;

const TABLES: Record<string, TableDefinition> = {
  social_links: {
    defaults: () => {
      const now = new Date().toISOString();
      return {
        id: crypto.randomUUID(),
        created_at: now,
        updated_at: now,
        platform: "x",
        verified: null,
        verified_type: null,
        is_identity_verified: null,
        subscription_type: null,
        verified_followers_count: null,
        followers_count: null,
        following_count: null,
        post_count: null,
        account_created_at: null,
      };
    },
    uniqueIndexes: [
      { name: "social_links_platform_platform_user_id_key", columns: ["platform", "platform_user_id"] },
    ],
    updatableColumns: new Set([
      "handle",
      "verified",
      "verified_type",
      "is_identity_verified",
      "subscription_type",
      "verified_followers_count",
      "followers_count",
      "following_count",
      "post_count",
      "account_created_at",
      "updated_at",
    ]),
    insertCheck: anyRow,
    updateUsing: anyRow,
    updateCheck: anyRow,
  },
  claims_history: {
    defaults: () => ({
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      platform: "x",
      reject_reason: null,
      usd_amount: null,
      token_amount: null,
      usd_price: null,
      currency: null,
      network_name: null,
      tx_hash: null,
    }),
    uniqueIndexes: [
      {
        name: "claims_one_per_wallet",
        columns: ["address"],
        where: (row) => ACTIVE_STATUSES.has(String(row.status)),
      },
      {
        name: "claims_one_per_account",
        columns: ["platform", "platform_user_id"],
        where: (row) => ACTIVE_STATUSES.has(String(row.status)),
      },
    ],
    updatableColumns: new Set(["status", "tx_hash"]),
    insertCheck: (row) => INSERTABLE_CLAIM_STATUSES.has(String(row.status)),
    updateUsing: (row) => row.status === "pending",
    updateCheck: (row) => SETTLED_CLAIM_STATUSES.has(String(row.status)),
  },
};

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/;

const compareValues = (left: unknown, right: string): number => {
  if (typeof left === "string" && ISO_TIMESTAMP.test(left) && ISO_TIMESTAMP.test(right))
    return Date.parse(left) - Date.parse(right);
  if (typeof left === "number") return left - Number(right);
  return String(left).localeCompare(right);
};

const matchesFilter = (row: Row, column: string, expression: string): boolean => {
  const dot = expression.indexOf(".");
  const operator = expression.slice(0, dot);
  const operand = expression.slice(dot + 1);
  const value = row[column];
  switch (operator) {
    case "eq":
      return value !== null && value !== undefined && String(value) === operand;
    case "in":
      return operand.replace(/^\(|\)$/g, "").split(",").includes(String(value));
    case "gte":
      return compareValues(value, operand) >= 0;
    case "lt":
      return compareValues(value, operand) < 0;
    default:
      throw new Error(`Fake PostgREST does not support operator ${operator}`);
  }
};

const RESERVED_PARAMS = new Set(["select", "order", "limit"]);

const jsonResponse = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });

interface InjectedFailure {
  method: string;
  table: string;
  status: number;
  body: Record<string, unknown>;
  afterCommit: boolean;
}

export class FakePostgrest {
  readonly tables: Record<string, Row[]> = { social_links: [], claims_history: [] };
  private failures: InjectedFailure[] = [];

  constructor(
    private readonly expectedPublishableKey: string,
    private readonly expectedWorkerJwt: string,
  ) {}

  rows(table: string): Row[] {
    const rows = this.tables[table];
    if (!rows) throw new Error(`Unknown table ${table}`);
    return rows;
  }

  seed(table: string, row: Row): Row {
    const definition = TABLES[table];
    if (!definition) throw new Error(`Unknown table ${table}`);
    const full = { ...definition.defaults(), ...row };
    this.rows(table).push(full);
    return full;
  }

  failNext(method: string, table: string): void {
    this.failures.push({ method, table, status: 503, body: { message: "Injected failure" }, afterCommit: false });
  }

  failNextAfterCommit(method: string, table: string): void {
    this.failures.push({ method, table, status: 503, body: { message: "Injected failure" }, afterCommit: true });
  }

  failNextWithUniqueViolation(table: string): void {
    this.failures.push({
      method: "POST",
      table,
      status: 409,
      body: { code: "23505", message: "duplicate key value violates unique constraint" },
      afterCommit: false,
    });
  }

  handle = async (request: Request): Promise<Response> => {
    if (request.headers.get("apikey") !== this.expectedPublishableKey)
      return jsonResponse({ message: "Invalid API key" }, 401);
    if (request.headers.get("Authorization") !== `Bearer ${this.expectedWorkerJwt}`)
      return jsonResponse({ code: "PGRST301", message: "JWT is not the worker's" }, 401);

    const url = new URL(request.url);
    const table = url.pathname.replace(/^\/rest\/v1\//, "");
    const definition = TABLES[table];
    if (!definition) return jsonResponse({ code: "42P01", message: "relation does not exist" }, 404);

    const failure = this.failures.find(
      (candidate) => candidate.method === request.method && candidate.table === table,
    );
    if (failure) this.failures = this.failures.filter((f) => f !== failure);
    if (failure && !failure.afterCommit) return jsonResponse(failure.body, failure.status);

    const response = await this.apply(request, table, definition, url);
    return failure ? jsonResponse(failure.body, failure.status) : response;
  };

  private async apply(request: Request, table: string, definition: TableDefinition, url: URL): Promise<Response> {
    const prefer = request.headers.get("Prefer") ?? "";
    const filtered = () => this.applyFilters(this.rows(table), url.searchParams);

    switch (request.method) {
      case "GET":
      case "HEAD":
        return this.select(request.method, filtered(), url.searchParams, prefer);
      case "POST":
        return this.insert(table, definition, (await request.json()) as Row, prefer);
      case "PATCH":
        return this.update(table, definition, filtered(), (await request.json()) as Row, prefer);
      default:
        return jsonResponse({ message: "Method not allowed" }, 405);
    }
  }

  private applyFilters(rows: Row[], params: URLSearchParams): Row[] {
    let result = rows;
    for (const [column, expression] of params) {
      if (RESERVED_PARAMS.has(column)) continue;
      result = result.filter((row) => matchesFilter(row, column, expression));
    }
    return result;
  }

  private select(method: string, rows: Row[], params: URLSearchParams, prefer: string): Response {
    let result = [...rows];
    const order = params.get("order");
    if (order) {
      const [column = "", direction] = order.split(".");
      result.sort((a, b) => compareValues(a[column], String(b[column])) * (direction === "desc" ? -1 : 1));
    }
    const total = result.length;
    const limit = params.get("limit");
    if (limit !== null) result = result.slice(0, Number(limit));

    const headers: Record<string, string> = {};
    if (prefer.includes("count=exact"))
      headers["Content-Range"] = result.length === 0 ? `*/${total}` : `0-${result.length - 1}/${total}`;
    if (method === "HEAD") return new Response(null, { status: 200, headers });
    return jsonResponse(result, 200, headers);
  }

  private violatedIndex(table: string, definition: TableDefinition, candidate: Row, ignore?: Row): UniqueIndex | undefined {
    return definition.uniqueIndexes.find((index) => {
      if (index.where && !index.where(candidate)) return false;
      return this.rows(table).some(
        (existing) =>
          existing !== ignore &&
          (!index.where || index.where(existing)) &&
          index.columns.every((column) => existing[column] === candidate[column]),
      );
    });
  }

  private permissionDenied(table: string): Response {
    return jsonResponse({ code: "42501", message: `permission denied for table ${table}` }, 403);
  }

  private policyViolation(table: string): Response {
    return jsonResponse(
      { code: "42501", message: `new row violates row-level security policy for table "${table}"` },
      403,
    );
  }

  private uniqueViolation(index: UniqueIndex): Response {
    return jsonResponse(
      { code: "23505", message: `duplicate key value violates unique constraint "${index.name}"` },
      409,
    );
  }

  private insert(table: string, definition: TableDefinition, input: Row, prefer: string): Response {
    const row = { ...definition.defaults(), ...input };
    if (!definition.insertCheck(row)) return this.policyViolation(table);
    const violated = this.violatedIndex(table, definition, row);
    if (violated) return this.uniqueViolation(violated);
    this.rows(table).push(row);
    return prefer.includes("return=representation")
      ? jsonResponse([row], 201)
      : new Response(null, { status: 201 });
  }

  private update(table: string, definition: TableDefinition, matches: Row[], patch: Row, prefer: string): Response {
    if (Object.keys(patch).some((column) => !definition.updatableColumns.has(column)))
      return this.permissionDenied(table);
    const targets = matches.filter(definition.updateUsing);
    if (targets.some((target) => !definition.updateCheck({ ...target, ...patch }))) return this.policyViolation(table);
    for (const target of targets) {
      const violated = this.violatedIndex(table, definition, { ...target, ...patch }, target);
      if (violated) return this.uniqueViolation(violated);
    }
    for (const target of targets) Object.assign(target, patch);
    return prefer.includes("return=representation")
      ? jsonResponse(targets, 200)
      : new Response(null, { status: 204 });
  }
}
