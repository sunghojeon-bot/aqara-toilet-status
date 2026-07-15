# 🚻 아카라 화장실 재실 현황판

1인용 화장실(층별 1칸)의 **사용 중 / 사용 가능** 상태를 실시간으로 보여주는 로컬 웹앱입니다.
Aqara MCP(`https://agent.aqara.com/open/mcp`)를 통해 **재실센서 + 열림감지센서** 상태를 조회합니다.

- 남자 화장실: **지하 1층 · 2층 · 4층**
- 공용 화장실: **1층**
- 여자 화장실: **3층 · 5층**
- 장비: 허브 6EA + 열림감지센서 6EA + 재실센서 6EA

## 실행 방법 (의존성 설치 불필요, Node.js 18+ 만 있으면 됨)

```bash
# 1) API 키 설정
cp .env.example .env
#    .env 를 열어 AQARA_API_KEY= 뒤에 발급받은 키를 붙여넣기 (값만, 꺾쇠/따옴표 금지)
#    키 발급: https://agent.aqara.com/login 로그인 → 키 복사

# 2) 서버 실행
node server.js

# 3) 브라우저에서 열기
#    http://localhost:3000
```

`.env` 에 키가 없으면 **데모 모드**로 실행되어 화면/동작을 미리 확인할 수 있습니다.
키를 넣으면 서버가 계속 그 키로 인증하므로 **한 번 설정 후 재로그인이 필요 없습니다.**

## 센서 매핑

1. 우측 상단 **⚙️ 센서 매핑** 클릭
2. **🔄 기기 불러오기** → 계정에 등록된 기기 목록에서 층별로 재실센서/열림감지센서 선택
3. 저장 → 5초 간격으로 자동 갱신

매핑 정보는 `config.json` 에 저장됩니다. (기기 목록 파싱이 안 될 경우 디바이스 ID를 직접 입력)

## 판정 로직 (1인용 기준, 재실센서 단독 판정)

| 재실센서 | 판정 |
|---|---|
| 재실 있음 (최근 N초 이내 감지) | 🔴 사용 중 |
| 재실 없음 | ✅ 사용 가능 |
| 센서 미연결/오프라인 | ⚪ 확인 불가 |

문 열림/닫힘은 **참고 표시 전용**이며 판정에 사용하지 않습니다.
`occupiedThresholdSec`(기본 90초)로 "사용 중" 유지 시간을 조절할 수 있습니다.

## Claude 에서 MCP 직접 연결 (참고)

```bash
claude mcp add --transport http aqara https://agent.aqara.com/open/mcp \
  --header "Authorization: Bearer $KEY" \
  --header "position_id: Aqr~fOItFleZImfdxxqamk"
```

## 진단용 엔드포인트

- `GET /api/status` — 층별 판정 결과(JSON)
- `GET /api/devices` — 계정 기기 목록 (raw 포함)
- `GET /api/tools` — MCP 서버가 제공하는 도구 목록
- `GET /api/raw` — 마지막 상태 조회 원본 응답 (파싱 문제 디버깅용)

<!-- deploy trigger 2026-07-15 -->
