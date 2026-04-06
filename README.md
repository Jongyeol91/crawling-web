# 찾았다봇 — 송파구 테니스장 예약 알림

송파구 공공 테니스장(성내천, 송파, 오금공원) 예약 현황을 조회하고 빈 자리를 알려주는 Slack 봇.

## 기능

- **@찾았다봇** — 3개 코트 전체 예약 현황 조회 + 필터 버튼
- **@찾았다봇 이번 주말 빈 데?** — 자연어 질문 (claude CLI 기반)
- **@찾았다봇 폴링** — 수동 폴링 실행
- **10분 자동 폴링** — 평일 18시 이후 + 주말 빈 자리 발생 시 알림
- **프리셋 필터** — 전체 / 주말만 / 평일저녁
- **스레드 답변** — 스레드에서 멘션하면 같은 스레드에 답변

## 기술 스택

- **Playwright** — 사이트 스크래핑 (spc.esongpa.or.kr)
- **@slack/bolt** — Socket Mode 봇
- **claude CLI** — 자연어 질문 분석
- **node-cron** — 폴링 스케줄링
- **launchd** — macOS 데몬 (상시 실행)

## 설치

```bash
npm install
npx playwright install chromium
```

## 설정

`.env.example`을 `.env`로 복사 후 값 채우기:

```bash
cp .env.example .env
```

필수 환경변수:
| 변수 | 설명 |
|------|------|
| `SLACK_BOT_TOKEN` | Slack Bot Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Slack App Token (`xapp-...`, Socket Mode) |
| `SLACK_CHANNEL_IDS` | 알림 채널 ID (쉼표 구분) |
| `SPC_USER_ID` | spc.esongpa.or.kr 로그인 ID |
| `SPC_PASSWORD` | spc.esongpa.or.kr 비밀번호 |

## Slack 앱 설정

1. https://api.slack.com/apps 에서 앱 생성
2. **Socket Mode** 활성화 → App Token 발급
3. **Bot Token Scopes**: `chat:write`, `app_mentions:read`, `channels:history`, `channels:join`, `channels:read`
4. **Event Subscriptions**: `app_mention`, `message.channels`
5. **App Home** → Bot Display Name 설정
6. Install App → Bot Token 복사

## 실행

```bash
# 직접 실행
npm run bot

# launchd로 상시 실행 (macOS)
cp launchd/com.podo.tennis-bot.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.podo.tennis-bot.plist

# 상태 확인
launchctl list | grep tennis-bot

# 로그 확인
tail -f logs/stdout.log
```

## 프로젝트 구조

```
src/
  slack-bot.ts          # 봇 메인 (Bolt + 크론 + 이벤트)
  slack-reporter.ts     # 스레드 메시지 포매팅
  llm-analyzer.ts       # claude CLI 자연어 분석
  calendar-scraper.ts   # 캘린더 스크래핑
  session-manager.ts    # Playwright 세션 관리
  login.ts              # 로그인 처리
  config.ts             # 환경변수 설정
  slot-filter.ts        # 시간대 필터링
  alert-dedup.ts        # 알림 중복 방지
  courts.ts             # 코트 정보
launchd/                # macOS 데몬 설정
```
