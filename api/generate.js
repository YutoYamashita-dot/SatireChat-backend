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

const EMPATHY_TOKENS = [
  "わかる", "それな", "たしかに", "確かに", "そうだね", "なるほど",
  "共感する", "ほんと", "本当", "まあね", "同感", "そうなんだよ"
];

function ensureEmpathy(text) {
  const hasEmpathy = EMPATHY_TOKENS.some((t) => text.includes(t));
  if (hasEmpathy) return text;
  // デフォルトで軽い共感を前置き
  return `わかる、${text}`;
}

// 長さ制約（10〜70字）を満たすように整形
function clampLength(text, word) {
  let t = String(text).trim().replace(/\s+/g, " ");
  // まず上限カット（句点等で自然に切れない場合は70字で強制）
  if (t.length > 70) {
    const cut = t.slice(0, 70);
    const lastPunc = Math.max(
      cut.lastIndexOf("。"),
      cut.lastIndexOf("、"),
      cut.lastIndexOf("！"),
      cut.lastIndexOf("？")
    );
    t = lastPunc >= 10 ? cut.slice(0, lastPunc + 1) : cut;
  }
  // 下限補強
  if (t.length < 10) {
    const filler = `…だよね。`;
    t = (t + filler).slice(0, 70);
    if (t.length < 10) {
      t = `${t}${word}の話だけどさ`;
      if (t.length > 70) t = t.slice(0, 70);
    }
  }
  return t;
}

function enforceConstraints(text, word) {
  // 共感ワード付与 → 文字数調整 → もう一度上限チェック
  let t = ensureEmpathy(text);
  t = clampLength(t, word);
  if (t.length > 70) t = t.slice(0, 70);
  // 句点が皆無なら軽く締める
  if (!/[。！？!?]$/.test(t) && t.length <= 68) t += "。";
  return t;
}

function sanitizeAndCoerce20(items, word) {
  // 20本固定で整形。speakerはA/B交互を強制。
  const base = Array.from({ length: 20 }, (_, i) => {
    const e = (Array.isArray(items) ? items : [])[i] || {};
    const rawText = String(e?.text ?? "");
    const enforced = enforceConstraints(rawText, word);
    return {
      speaker: i % 2 === 0 ? "A" : "B",
      text: enforced
    };
  });

  // ★ 最後の1行は「そうだね。」のみ（他の文は出力しない）
  base[19].text = "そうだね。";

  // 長さフィルタ（10〜70字）— ただし最後(19)は「そうだね。」を許可
  const cleaned = base.filter((e, i) =>
    i === 19 ? e.text === "そうだね。" : (e.text && e.text.length >= 10 && e.text.length <= 70)
  );

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
    const model = process.env.XAI_MODEL || "grok-4-fast-reasoning";

    const systemPrompt = [
      "You are a dialogue generator that writes witty satire/irony banter as two fictional speakers A and B.",
      "Hard constraints:",
      "- Focus the satire/irony/complaints on the given 'word' topic; do not attack protected classes or real identifiable people.",
      "- Each line MUST include a brief empathetic phrase (e.g., Japanese equivalents of 'I get it', '確かに', 'それな').",
      "- Output in Japanese.",
      "- Exactly 20 exchanges (A/B alternating), one-liner each.",
      "- Each text length MUST be between 10 and 70 Japanese characters inclusive.",
      "- The FINAL (20th) line must be exactly: 「そうだね。」 with no other words.",
      '- Return ONLY valid JSON: {"data":[{"speaker":"A"|"B","text":"..."} x20]} with no extra text.'
    ].join("\n");

    const userPayload = {
      word,
      tone: toneLevel,
      styleGuide: {
        lengthPerLine: "10-70 chars per line (final line exempt, must be exactly そうだね。)",
        register: toneLevel,
        mustInclude: "an empathetic phrase in each line (e.g., わかる, それな, たしかに, なるほど) — except the final line which must be exactly そうだね。",
        target: `satire/irony/complaints aimed at the topic "${word}" (ideas/institutions/behaviors; no protected-class attacks)`,
        avoid: ["protected-class attacks", "real-person doxxing", "violence incitement", "sexual explicit content"],
        prefer: ["clever social satire", "wordplay", "benign violation"],
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
                        // 最終行は後段で上書きするため、ここは一般ルールのまま
                        text: { type: "string", minLength: 10, maxLength: 70 }
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
      data?.choices?.[0]?.message?.content?.[0]?.text ??
      "";

    let out = parseLLMJson(content);
    if (!out && content) {
      try {
        const obj = JSON.parse(content.replace(/```json|```/g, "").trim());
        if (obj && Array.isArray(obj.data)) out = obj.data;
      } catch {}
    }

    const cleaned = sanitizeAndCoerce20(out, word);
    if (!cleaned) {
      return res.status(502).json({ error: "Upstream invalid JSON format or length constraints not met" });
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
