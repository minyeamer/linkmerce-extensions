# Coupang Cookies

쿠팡 Wing에 로그인한 뒤 Wing과 광고센터 쿠키를 각각 Slack 채널로 전송하는 Chrome Manifest V3 확장 프로그램입니다. 광고센터는 Wing의 좌측 메뉴 링크를 통해 인증을 이어받고, 최종 목표 주소 `https://advertising.coupang.com/marketing/dashboard/sales?off_site_source=wing.lnb.ads_center`에 도착했는지 확인합니다.

## 설치 및 사용

1. 기존 확장 프로그램의 설정을 유지하려면 먼저 설정 JSON을 내보냅니다. 폴더와 확장 프로그램 ID가 바뀌므로 새 확장 프로그램에 JSON을 불러와야 합니다. Chrome에서 기존 Coupang Ads와 Wing 확장 프로그램을 제거한 뒤, 개발자 모드를 켜고 **압축해제된 확장 프로그램을 로드합니다**로 이 폴더를 선택합니다.
2. 팝업에서 공통 Slack Bot Token과 Wing·광고센터 채널 ID를 각각 입력합니다. 파일명도 서비스별로 설정할 수 있으며 변경 사항은 자동 저장됩니다.
3. **추출 & 전송**은 Wing 로그인을 확인하고 광고센터 목표 페이지까지 연 뒤, Wing 쿠키와 광고센터 쿠키를 각각 지정 채널에 올립니다.
4. **새로고침만**과 **새로고침 스케줄**은 같은 로그인·광고센터 이동 및 목표 URL 검증을 수행하고 Slack에는 전송하지 않습니다.
5. Bot에 files:write, chat:write 권한을 부여하고 두 대상 채널에 초대합니다.

naver-cookies와 동일한 수동 실행, 두 독립 스케줄, 다음 실행 시각, 실행 결과, JSON 설정 내보내기·불러오기를 지원합니다. 스케줄은 설치 시 기본적으로 꺼져 있으며 브라우저 재시작 시 복원됩니다. 시각은 브라우저의 로컬 시간대를 따릅니다. Chrome이 실행 중이어야 하며 절전 상태에서는 실행이 지연될 수 있습니다.

전송 및 새로고침 간격 모드의 기준 시각(`baseTime`)은 `HH:MM:SS` 형식(예: `08:00:30`)으로 초까지 설정할 수 있습니다. 기존 `HH:MM` 설정은 초를 `00`으로 처리합니다. 반복 간격은 분 단위를 유지하며, Chrome의 알람은 브라우저 상태에 따라 예약 시각보다 늦게 실행될 수 있습니다.

## 쿠키 범위와 전송

- Wing과 advertising.coupang.com 각각에 적용되는 서비스 쿠키와 공통 부모 도메인 쿠키(예: .coupang.com)를 별도 수집합니다. 다른 쿠팡 서비스 전용 쿠키는 제외합니다.
- 같은 이름은 서비스 전용 도메인과 긴 경로를 우선하여 하나만 남기고 이름순으로 정렬합니다. 파일 형식은 name=value; name2=value2 입니다.
- 광고센터는 Wing 좌측 메뉴를 클릭해 새 탭으로 연 뒤 목표 URL을 확인합니다. 메뉴 클릭이나 새 탭 열기가 실패하면 목표 URL로 직접 이동하고, 광고센터 로그인 선택 화면에서는 Wing 로그인 링크(`a[href^="/user/login?_cap_client=WING"]`)를 눌러 기존 Wing 세션으로 로그인합니다. 로그인 뒤 다른 경로에 도착하면 목표 URL로 다시 이동합니다.
- 최종 목표 URL은 `https://advertising.coupang.com/marketing/dashboard/sales?off_site_source=wing.lnb.ads_center`입니다. Access Denied·로그인 미완료·쿠키 누락 시 Slack 전송을 중단합니다.
- 로그인 세션은 Wing의 로그인 폼과 완료 후 루트 주소를 기준으로 확인합니다. 로그아웃 상태에서는 Chrome의 저장된 자동완성 계정으로 로그인합니다.
- 두 쿠키 파일은 공통 Bot Token을 사용하지만 각각 별도 Slack 채널로 전송합니다.
- Slack Files API의 getUploadURLExternal → 업로드 → completeUploadExternal 순서를 사용합니다.

이전 Wing 설정 파일은 Wing 채널·스케줄을, Ads v0.2.x 설정 파일은 광고센터 채널을 통합 설정으로 가져옵니다. 설정은 확장 프로그램별 로컬 저장소에 보관됩니다. 내보낸 JSON에는 Slack 토큰이 포함되며, 업로드한 쿠키 파일에는 인증 정보가 포함될 수 있으므로 접근 권한을 관리하세요.

## 빌드

저장소 루트에서 다음 명령을 실행합니다.

```powershell
node build.js coupang-cookies
```

결과는 dist/coupang-cookies/ 에 생성됩니다.

## 권한

cookies(쿠키 읽기), tabs(작업 탭 관리), scripting/debugger(로그인·광고센터 메뉴 확인 및 클릭), alarms(스케줄), storage(설정·결과 저장)를 사용합니다. 호스트 권한은 wing.coupang.com, xauth.coupang.com, advertising.coupang.com, slack.com, files.slack.com입니다.
