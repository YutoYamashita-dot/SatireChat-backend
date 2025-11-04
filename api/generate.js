// api/generate.js
// Vercel Node.js (ESM) — 「言葉」→ A/Bの20ラリー風刺掛け合い(JSON) を返す
// 環境変数: XAI_API_KEY(必須), XAI_MODEL(任意; 既定 "grok-4")

export const config = { runtime: "nodejs" };

// ---- xAI (Grok) Chat Completions エンドポイント ----
const XAI_URL = "https://api.x.ai/v1/chat/completions";

function normTone(toneRaw = "") {
  const t = String(toneRaw || "").toLowerCase();
  if (t.includes("辛") || t.includes("hard") || t.includes("harsh")) return "harsh";
  if (t.includes("哲") || t.includes("philo")) return "philosophical";
  if (t.includes("深夜") || t.includes("late")) return "late-night";
  if (t.includes("ゆる") || t.includes("mild")) return "mild";
  return "normal";
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function isRetryableStatus(status, msg = "") {
  if (!status) return false;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  // 一部SDKは status を埋めないことがあるので message でもチェック
  return /(?:\b429\b|5\d\d)/.test(String(msg));
}

async function withRetry(fn, times = 3) {
  let lastErr;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e?.status || e?.response?.status;
      const msg = e?.message || "";
      if (isRetryableStatus(status, msg) && i < times - 1) {
        // 400ms, 800ms, 1600ms ...
        const wait = 400 * 2 ** i;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

// LLMからの content を安全に JSON へ
function parseLLMJson(content) {
  if (!content) return null;
  // ```json ... ``` の柵を除去
  const stripped = content.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.data)) return parsed.data;
  } catch {}
  return null;
}

function sanitizeAndCoerce20(items) {
  // items: [{speaker,text}] を20本に整える。speakerはA/B交互を強制。
  const sliced = (Array.isArray(items) ? items : []).slice(0, 20);
  const cleaned = sliced
    .map((e, i) => ({
      speaker: i % 2 === 0 ? "A" : "B",
      text: String(e?.text ?? "").trim().replace(/\s+/g, " ")
    }))
    .filter((e) => e.text.length > 0);

  return cleaned.length === 20 ? cleaned : null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const { word, tone } = req.body || {};
    if (!word || typeof word !== "string") {
      return res.status(400).json({ error: "Missing 'word' (string)" });
    }
    if (!process.env.XAI_API_KEY) {
      return res.status(500).json({ error: "XAI_API_KEY is not set" });
    }

    const toneLevel = normTone(tone);
    const model = process.env.XAI_MODEL || "grok-4";

    const systemPrompt = [
      "You are a dialogue generator that writes witty satire/irony banter as two fictional speakers A and B.",
      "Hard constraints:",
      "- Keep it sharp: focus on ideas, institutions, trends, generic characters.",
      "- Output in Japanese.",
      "- Exactly 20 exchanges (A/B alternating), one-liner each.",
      '- Return ONLY valid JSON: {"data":[{"speaker":"A"|"B","text":"..."} x20]} with no extra text.'
    ].join("\n");

    const userPayload = {
      word,
      tone: toneLevel,
      styleGuide: {
        lengthPerLine: "short",
        register: toneLevel,
        avoid: ["protected-class attacks", "violence incitement"],
        prefer: ["clever social satire", "workplace/tech/romance generic archetypes", "wordplay", "benign violation"],
        format: "A/B alternating for 20 lines total"
      }
    };

    // ---- Timeout 付けて xAI に投げる（OpenAI互換ペイロード）----
    const AC = new AbortController();
    const TIMEOUT_MS = 8000;
    const timer = setTimeout(() => AC.abort(), TIMEOUT_MS);

    const fetchOnce = async () => {
      const resp = await fetch(XAI_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.XAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        signal: AC.signal,
        body: JSON.stringify({
          model,
          temperature: toneLevel === "harsh" || toneLevel === "late-night" ? 0.9 : 0.7,
          // xAI は OpenAI 互換API。response_format の json_schema を理解するモデルが多い。
          // モデル互換性のため、まずは "json_object" を優先し、壊れた場合はフェイルセーフで再parse。
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "banter_schema",
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["data"],
                properties: {
                  data: {
                    type: "array",
                    minItems: 20,
                    maxItems: 20,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["speaker", "text"],
                      properties: {
                        speaker: { enum: ["A", "B"] },
                        text: { type: "string" }
                      }
                    }
                  }
                }
              }
            }
          },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(userPayload) }
          ]
        })
      });

      if (!resp.ok) {
        const msg = await safeText(resp);
        const err = new Error(`Upstream ${resp.status}: ${msg || resp.statusText}`);
        err.status = resp.status;
        throw err;
      }

      const data = await resp.json();
      return data;
    };

    const data = await withRetry(fetchOnce, 3);
    clearTimeout(timer);

    // ---- 応答から content を抽出し、安全にJSON化 ----
    const content =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.message?.content?.[0]?.text ?? // 互換のための保険
      "";

    let out = parseLLMJson(content);
    // もし schema で {"data":[...]} が来ているなら優先
    if (!out && content) {
      try {
        const obj = JSON.parse(content.replace(/```json|```/g, "").trim());
        if (obj && Array.isArray(obj.data)) out = obj.data;
      } catch {}
    }

    const cleaned = sanitizeAndCoerce20(out);
    if (!cleaned) {
      // モデルが schema を守れなかった場合は 502（上流不整合）
      return res.status(502).json({ error: "Upstream invalid JSON format" });
    }

    return res.status(200).json({ data: cleaned });
  } catch (e) {
    if (e?.name === "AbortError") {
      return res.status(504).json({ error: "Upstream timeout" });
    }
    console.error("[/api/generate] error:", e);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

async function safeText(resp) {
  try {
    const t = await resp.text();
    return t?.slice(0, 500);
  } catch {
    return "";
  }
}