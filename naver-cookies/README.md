# Naver-Cookies

> 네이버 세션 쿠키를 주기적으로 추출하여 Slack 채널에 텍스트 파일로 업로드하는 크롬 확장 프로그램

Linux 서버(Airflow 등)에서 네이버 로그인 세션이 필요할 때, 실제 브라우저의 쿠키를 Slack을 통해 공유하여 봇 감지 없이 인증을 유지합니다.

## 왜 크롬 확장 프로그램인가?

| 방식 | 결과 | 이유 |
|------|------|------|
| Playwright (headless) | ❌ 실패 | 네이버 봇 감지 — 세션 유지 불가 |
| Python + requests | ❌ 실패 | 2FA / 캡챠 등 브라우저 인증 우회 불가 |
| **크롬 확장 프로그램** | ✅ 채택 | 실제 사용자 브라우저의 쿠키를 직접 추출 |

## 아키텍처

```
[팝업 UI (popup.html / popup.js)]
      │  설정 관리 + 수동 실행
      ▼
[Service Worker (background.js)]
      │  chrome.cookies API → .naver.com 쿠키 추출
      │  chrome.alarms API → 두 가지 독립 스케줄
      │   ├─ ALARM_SEND:    탭 새로고침 → 쿠키 추출 → Slack 파일 업로드
      │   └─ ALARM_REFRESH: 탭 새로고침만 (세션 유지용)
      │  Slack Files API (v2) → 텍스트 파일 업로드
      ▼
[Linux 서버 (Airflow)]
      │  Slack에서 쿠키 파일 다운로드 → 요청 헤더에 주입
      ▼
[네이버 API 호출 성공]
```

## 주요 기능

### 두 가지 독립 스케줄

| 스케줄 | 역할 | 모드 |
|--------|------|------|
| **Slack 전송 스케줄** | 탭 새로고침 → 쿠키 추출 → Slack 업로드 | 간격(interval) / 시각(times) |
| **새로고침 스케줄** | Slack 전송 없이 네이버 탭만 새로고침 | 간격(interval) |

- **간격 모드**: N분마다 반복. 기준 시각(baseTime) 설정으로 발화 시점 정렬 가능
- **시각 모드**: 지정한 시각(HH:MM)에 one-shot 실행, 완료 후 다음 시각 자동 예약

### NID_SES 검증

쿠키 전송 시 `NID_SES` 쿠키 존재를 확인하여, 로그인이 풀린 상태에서의 무의미한 전송을 방지합니다.

### 설정 내보내기 / 불러오기

JSON 파일로 전체 설정(Slack, 전송 스케줄, 새로고침 스케줄)을 내보내고 불러올 수 있습니다. 확장 프로그램 재설치 시 설정을 복원할 때 유용합니다.

## 설치

### 개발 버전 로드

```
1. chrome://extensions/ 접속
2. 개발자 모드 ON
3. "압축해제된 확장프로그램을 로드합니다" 클릭
4. naver-cookies/ 폴더 선택
```

### 난독화 빌드 (선택)

리포지토리 루트의 빌드 스크립트를 사용합니다. 자세한 내용은 [루트 README](../README.md) 참조.

## 사용 방법

1. **Slack 설정**: Bot Token (`xoxb-...`), Channel ID, 파일명 입력
   - Bot에 `chat:write`, `files:write` 권한 필요
2. **전송 스케줄**: 간격 또는 시각 모드로 자동 전송 주기 설정
3. **새로고침 스케줄**: Slack 전송 없이 세션 유지용 새로고침 주기 설정
4. **수동 실행**: "추출 & 전송" 또는 "새로고침만" 버튼으로 즉시 실행

## 스케줄 설정 형식

```jsonc
// Slack 전송 스케줄
{
  "enabled": true,
  "mode": "interval",          // "interval" | "times"
  "intervalMinutes": 1440,     // 간격 모드: 반복 간격 (분)
  "baseTime": "00:00",         // 간격 모드: 발화 기준 시각
  "times": ["08:00", "20:00"]  // 시각 모드: 실행 시각 목록
}

// 새로고침 스케줄
{
  "enabled": true,
  "intervalMinutes": 30,
  "baseTime": "00:00"
}
```

## 파일 구조

```
naver-cookies/
├── manifest.json       확장 프로그램 설정
├── background.js       Service Worker — 쿠키 추출, Slack 업로드, 알람 관리
├── popup.html          팝업 UI 구조
├── popup.css           스타일 (네이버 그린 테마)
├── popup.js            팝업 이벤트 처리 및 설정 관리
├── icons/              icon16 / icon32 / icon48 / icon128 PNG
└── README.md
```

## 권한

| 권한 | 용도 |
|------|------|
| `cookies` | `.naver.com` 도메인 쿠키 읽기 |
| `alarms` | 스케줄 알람 등록 |
| `storage` | 설정 및 실행 로그 저장 |
| `tabs` | 네이버 탭 새로고침 |
| `host_permissions` | `*.naver.com`, `slack.com` 접근 |
