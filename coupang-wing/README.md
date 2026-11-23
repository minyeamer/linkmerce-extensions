# coupang-wing

쿠팡 Wing 탭을 새로고침하고 쿠키를 Slack에 텍스트 파일로 전송하는 Chrome Manifest V3 확장 프로그램입니다.

## 설치 및 사용

1. chrome://extensions/ 에서 개발자 모드를 켜고 **압축해제된 확장 프로그램을 로드합니다**로 이 폴더를 선택합니다.
2. https://wing.coupang.com/ 에 로그인한 탭을 열어 둡니다. 여러 탭이 있으면 첫 번째 탭을 새로고침합니다.
3. 팝업에서 Slack Bot Token, Channel ID, 파일명(.txt 제외)을 입력합니다. 변경 사항은 자동 저장됩니다. Bot에 files:write, chat:write 권한을 부여하고 대상 채널에 초대합니다.
4. **추출 & 전송**으로 수동 실행하거나 **Slack 전송 스케줄**을 켭니다. 간격(기준 시각 포함) 또는 매일 지정 시각을 선택할 수 있습니다.
5. **새로고침 스케줄**은 Slack 전송 없이 세션 유지용 새로고침만 실행합니다.

naver-cookies와 동일한 수동 실행, 두 독립 스케줄, 다음 실행 시각, 실행 결과, JSON 설정 내보내기·불러오기를 지원합니다. 스케줄은 설치 시 기본적으로 꺼져 있으며 브라우저 재시작 시 복원됩니다. 시각은 브라우저의 로컬 시간대를 따릅니다. Chrome이 실행 중이어야 하며 절전 상태에서는 실행이 지연될 수 있습니다.

## 쿠키 범위와 전송

- wing.coupang.com에 적용되는 서비스 쿠키와 공통 부모 도메인 쿠키(예: .coupang.com)를 수집합니다. 다른 쿠팡 서비스 전용 쿠키는 제외합니다.
- 같은 이름은 서비스 전용 도메인과 긴 경로를 우선하여 하나만 남기고 이름순으로 정렬합니다. 파일 형식은 name=value; name2=value2 입니다.
- 탭이 없거나 새로고침 실패·시간 초과 또는 쿠키가 없으면 전송을 중단하고 오류를 기록합니다.
- 네이버 전용 NID_SES 검사는 사용하지 않습니다. 쿠키 존재만 확인하며 로그인 유효성은 검증하지 않으므로 로그아웃 상태라면 다시 로그인하세요.
- Slack Files API의 getUploadURLExternal → 업로드 → completeUploadExternal 순서를 사용합니다.

설정은 확장 프로그램별 로컬 저장소에 보관됩니다. 내보낸 JSON에는 Slack 토큰이 포함되며, 업로드한 쿠키 파일에는 인증 정보가 포함될 수 있으므로 접근 권한을 관리하세요.

## 빌드

저장소 루트에서 다음 명령을 실행합니다.

```powershell
node build.js coupang-wing
```

결과는 dist/coupang-wing/ 에 생성됩니다.

## 권한

cookies(쿠키 읽기), tabs(대상 탭 조회·새로고침), alarms(스케줄), storage(설정·결과 저장)를 사용합니다. 호스트 권한은 wing.coupang.com, slack.com, files.slack.com으로 제한합니다.
