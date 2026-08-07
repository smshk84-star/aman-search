const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

const uniqueSources = (annotations) => {
  const seen = new Set();
  return annotations
    .map((item) => item.url_citation || item)
    .filter((item) => item && item.url && !seen.has(item.url) && seen.add(item.url))
    .map(({ url, title }) => ({ url, title: title || new URL(url).hostname }));
};

export default async (request) => {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!process.env.OPENAI_API_KEY) return json(503, { error: "OPENAI_API_KEY is not configured on this site." });

  let query;
  try { ({ query } = await request.json()); } catch { return json(400, { error: "Invalid request body." }); }
  query = typeof query === "string" ? query.trim() : "";
  if (!query || query.length > 1000) return json(400, { error: "Enter a search query of up to 1,000 characters." });

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-5.6-terra",
        reasoning: { effort: "low" },
        tools: [{ type: "web_search", search_context_size: "medium" }],
        tool_choice: "required",
        include: ["web_search_call.action.sources"],
        input: `Answer the user's question using current web sources. Be concise and factual. Cite factual claims with the provided web citations. User question: ${query}`,
      }),
      signal: AbortSignal.timeout(55000),
    });
    const payload = await response.json();
    if (!response.ok) return json(response.status, { error: payload.error?.message || "OpenAI search request failed." });

    const content = payload.output?.flatMap((item) => item.type === "message" ? item.content || [] : [])
      .find((item) => item.type === "output_text");
    if (!content?.text) return json(502, { error: "The AI search service returned no answer." });

    const annotations = (content.annotations || []).map((item) => item.url_citation || item)
      .filter((item) => item?.type === "url_citation" || item?.url);
    return json(200, { answer: content.text, annotations, sources: uniqueSources(annotations) });
  } catch (error) {
    if (error.name === "TimeoutError") return json(504, { error: "The AI search request timed out. Please try again." });
    return json(502, { error: "Unable to reach the AI search service. Please try again." });
  }
};
