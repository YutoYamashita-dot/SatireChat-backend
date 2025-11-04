// api/generate.js
// Vercel Node.js (ESM) - 入力ワードに対する「A/Bの20ラリー風刺掛け合い」をJSONで返す
// 必須: OPENAI_API_KEY
// 任意: OPENAI_MODEL（未設定なら gpt-5）

export const config = { runtime: "nodejs" };

import OpenAI from "openai";

// ---- ユーティリティ ----
function normTone(toneRaw = "") {
  const t = (toneRaw || "").toLowerCase();
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

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { word, tone } = req.body || {};
    if (!word || typeof word !== "string") {
      return res.status(400).json({ error: "Missing 'word' (string)" });
    }

    const toneLevel = normTone(tone);

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-5";

    const system = [
      "You are a dialogue generator that writes witty satire/irony banter as two fictional speakers A and B.",
      "Hard constraints:",
      "- Absolutely NO hateful content toward protected classes. NO slurs. NO harassment of real identifiable individuals.",
      "- Keep it sharp, but legal/safe: focus on ideas, institutions, trends, generic characters.",
      "- Use Japanese language output.",
      "- Exactly 20 exchanges (A/B alternating), concise one-liners per turn.",
      "- Return ONLY valid JSON array of objects: [{\"speaker\":\"A\"|\"B\",\"text\":\"...\"}, ...]. No extra commentary."
    ].join("\n");

    const user = JSON.stringify({
      word,
      tone: toneLevel,
      styleGuide: {
        lengthPerLine: "short",
        register: toneLevel, // mild/normal/harsh/late-night/philosophical
        avoid: [
          "protected-class attacks",
          "violence incitement"
          
        ],
        prefer: [
          "clever social satire",
          "workplace/tech/romance generic archetypes",
          "wordplay",
          "benign violation"
        ],
        format: "A/B alternating for 20 lines total"
      }
    });

    const completion = await client.chat.completions.create({
      model,
      temperature: toneLevel === "harsh" || toneLevel === "late-night" ? 0.9 : 0.7,
      response_format: { type: "json_object" }, // 安定化のため一旦obj→中でarray
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content || "";
    // 返答は {"data":[{speaker,text},...]} or 直接配列 を許容
    let out;
    try {
      const parsed = JSON.parse(raw);
      out = Array.isArray(parsed) ? parsed : parsed.data;
    } catch {
      return res.status(502).json({ error: "LLM returned invalid JSON" });
    }

    if (!Array.isArray(out)) {
      return res.status(502).json({ error: "Malformed JSON (not an array)" });
    }

    // 最低限のバリデーション
    const cleaned = out
      .slice(0, 20)
      .map((e, i) => ({
        speaker: i % 2 === 0 ? "A" : "B",
        text: String(e?.text || "").trim().replace(/\s+/g, " ")
      }))
      .filter(e => e.text.length > 0);

    if (cleaned.length < 20) {
      return res.status(502).json({ error: "Less than 20 exchanges" });
    }

    return res.status(200).json({ data: cleaned });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
