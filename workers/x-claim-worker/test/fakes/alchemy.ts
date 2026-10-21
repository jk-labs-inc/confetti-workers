export const ALCHEMY_ORIGIN = "https://api.g.alchemy.com";

export class FakeAlchemy {
  usdPrice = "0.25";
  status = 200;
  answersWithHtml = false;

  constructor(private readonly apiKey: string) {}

  handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== `/prices/v1/${this.apiKey}/tokens/by-symbol`)
      return Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
    if (this.status !== 200)
      return Response.json({ error: { message: "Unavailable" } }, { status: this.status });
    if (this.answersWithHtml) return new Response("<html>Bad gateway</html>", { headers: { "Content-Type": "text/html" } });

    const symbols = url.searchParams.getAll("symbols");
    return Response.json({
      data: symbols.map((symbol) => ({
        symbol,
        prices: [{ currency: "usd", value: this.usdPrice, lastUpdatedAt: new Date().toISOString() }],
        error: null,
      })),
    });
  };
}
