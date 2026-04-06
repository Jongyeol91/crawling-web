/**
 * llm-analyzer.ts
 *
 * Uses the local `claude` CLI to analyze scraped tennis court data
 * and answer natural language questions.
 */

import { spawn } from "node:child_process";
import type { CourtCalendarResult } from "./calendar-scraper.js";
import { logger } from "./logger.js";

const COURT_KEYWORDS = [
  "예약", "빈", "코트", "시간", "가능", "주말", "오후", "오전", "저녁",
  "성내천", "송파", "오금", "황금", "조회", "현황", "내일", "오늘", "토요일",
  "일요일", "평일", "잔여", "면", "슬롯",
];

/**
 * Determine if the question needs court scraping data or is a general question.
 */
export function needsCourtData(question: string): boolean {
  return COURT_KEYWORDS.some((kw) => question.includes(kw));
}

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

/** Run claude CLI with prompt via stdin to avoid shell escaping issues */
function runClaude(prompt: string, model: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_PATH, ["-p", "--model", model], {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Claude CLI timeout"));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `exit code ${code}`));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Serialize scraped results into a compact text format for the LLM.
 */
function serializeResults(results: CourtCalendarResult[]): string {
  const lines: string[] = [];
  const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

  for (const r of results) {
    const available = r.slots.filter((s) => s.available);
    if (available.length === 0) continue;

    lines.push(`\n[${r.court.name} 테니스장]`);

    // Group by date
    const byDate = new Map<string, typeof available>();
    for (const s of available) {
      if (!byDate.has(s.date)) byDate.set(s.date, []);
      byDate.get(s.date)!.push(s);
    }

    for (const [date, slots] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const dayName = DAY_NAMES[slots[0].dayOfWeek] ?? "";
      const times = slots
        .sort((a, b) => a.time.localeCompare(b.time))
        .map((s) => {
          const courts = s.availableCourts || "";
          return `${s.time}${courts ? ` (${courts})` : ""}`;
        })
        .join(", ");
      lines.push(`  ${date}(${dayName}): ${times}`);
    }
  }

  return lines.join("\n");
}

/**
 * Ask Claude CLI to analyze the scraped data and answer a user question.
 */
export async function analyzeWithLLM(
  question: string,
  results: CourtCalendarResult[]
): Promise<string> {
  const data = serializeResults(results);
  const today = new Date().toLocaleDateString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });

  const prompt = `<role>
당신은 '찾았다봇', 송파구 테니스장 예약 현황을 알려주는 슬랙봇입니다. 성격이 밝고 유머러스합니다.
</role>

<context>
오늘 날짜: ${today}
</context>

<data>
${data}
</data>

<instructions>
- 위 데이터를 기반으로 사용자 질문에 답변하세요
- 데이터에 없는 내용은 "데이터에 없습니다"라고 답변하세요
- 텍스트만 사용하고 이모지 없이 작성하세요. 슬랙 텍스트 기반 대화에서 읽히므로 간결한 문체가 중요합니다
- 슬랙 mrkdwn 형식으로 작성하세요 (*볼드*, \`코드\` 등)
- 3~5문장 이내로 핵심만 전달하세요
</instructions>

<example>
질문: "이번 주 토요일 오후에 칠 수 있는 곳?"
답변: 이번 주 토요일(4/5)은 안타깝게도 3곳 모두 오후 시간대가 꽉 찼습니다. 대신 일요일(4/6) 성내천에서 14~16시, 16~18시 자리가 남아있으니 한번 노려보세요.
</example>

<question>${question}</question>`;

  try {
    logger.info(`[LLM] Calling claude CLI with question: "${question}"`);

    const answer = await runClaude(prompt, "sonnet", 60_000);
    logger.info(`[LLM] Response received (${answer.length} chars)`);
    return answer;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[LLM] Claude CLI error: ${errMsg}`);
    return `⚠️ LLM 분석 실패: ${errMsg}`;
  }
}

/**
 * Answer a general question (no court data needed) using haiku for speed.
 */
export async function chatWithLLM(question: string): Promise<string> {
  const prompt = `<role>
당신은 '찾았다봇', 송파구 테니스장 예약 봇입니다. 성격은 쿨하고 드라이한 유머 스타일. 진부한 응원이나 뻔한 격려는 절대 하지 않습니다. 친구한테 말하듯 짧고 툭툭 던지는 말투입니다.
</role>

<instructions>
- 1~2문장, 최대 30자 이내로 답변하세요
- 진부한 표현 금지: "화이팅", "멋진", "좋은 경기", "기다릴 가치", "응원" 같은 말 쓰지 마세요
- 이모지 쓰지 마세요
- 슬랙 mrkdwn 형식으로 작성하세요
</instructions>

<example>
질문: "뭐해?"
답변: 코트 빈자리 감시하는 중.

질문: "ㅜㅜ 다 찼네"
답변: 송파 테니스장 인기가 너무 좋아서 탈이야.
</example>

<question>${question}</question>`;

  try {
    logger.info(`[LLM] General chat: "${question}"`);

    const answer = await runClaude(prompt, "haiku", 30_000);
    logger.info(`[LLM] Chat response (${answer.length} chars)`);
    return answer;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[LLM] Chat error: ${errMsg}`);
    return `⚠️ 답변 실패: ${errMsg}`;
  }
}
