# NSP-Extractor

> 네이버 스마트스토어 / 브랜드스토어 상품 데이터 대량 수집 크롬 확장 프로그램

수천 개의 상품 URL을 입력받아 가격, 재고, 리뷰, 옵션 데이터를 CSV / JSON으로 자동 추출합니다.

---

## 왜 크롬 확장 프로그램인가?

| 방식 | 결과 | 이유 |
|------|------|------|
| Playwright (headless) | ❌ 실패 | 429 Too Many Requests — 봇 감지 |
| Python + requests | ❌ 실패 | JS 렌더링 없이 API 응답 불가 |
| **크롬 확장 프로그램** | ✅ 채택 | 실제 사용자 쿠키/세션 활용, 봇 감지 우회 |

---

## 아키텍처

```
[팝업 UI (popup.html / popup.js)]
      │  chrome.runtime.sendMessage(startCollection)
      ▼
[Service Worker (background.js)]
      │  declarativeNetRequest로 요청 헤더 조작
      │  네이버 내부 API 직접 호출 (쿠키 자동 첨부)
      │   ├─ /i/v1/smart-stores?url=        채널 정보 획득
      │   └─ /i/v2/channels/{uid}/products/{id}  상품 데이터 획득
      │  결과 → chrome.storage.local 저장
      ▼
[popup.js]  결과 테이블 렌더링 → CSV / JSON 다운로드
```

---

## 수집 데이터

### 상품 (products)

| 컬럼 | 필드 | 설명 |
|------|------|------|
| 상품코드 | `productId` | URL의 숫자 ID |
| 상품번호 | `productNo` | 내부 상품번호 |
| 판매처순번 | `mallNo` | 판매처 고유 번호 |
| 판매처명 | `mallName` | 스토어명 |
| 채널ID | `channelId` | 네이버 채널 번호 |
| 채널명 | `channelName` | 채널명 |
| 브랜드ID | `brandId` | 브랜드 ID |
| 브랜드명 | `brandName` | 브랜드명 |
| 카테고리ID | `categoryId` | 카테고리 코드 |
| 카테고리 | `categoryName` | 카테고리명 |
| 상품명 | `productName` | 상품명 |
| 판매가 | `price` | 정가 |
| 할인가 | `salesPrice` | 실제 판매가 (할인 없으면 판매가와 동일) |
| 재고수량 | `stockQuantity` | 옵션/추가상품 합산 재고 |
| 리뷰수 | `reviewCount` | 누적 리뷰 수 |
| 평점 | `reviewScore` | 평균 평점 |
| 품절여부 | `soldout` | Y / N |
| 상태 | `status` | `success` / `paused` / `deleted` / `soldout` / `error` |
| 배송속성 | `deliveryType` | 배송 유형 |
| 전체카테고리 | `wholeCategoryName` | 전체 카테고리 경로 |
| 상품주소 | `productUrl` | 입력 URL 원본 |
| 수집시간 | `timestamp` | ISO 8601 |

### 옵션 (options)

조합형/단독형 옵션별 한 행씩. `optionGroup1~3`, `optionName1~3`, `optionPrice`, `stockQuantity`, `registerDate` 포함.

### 추가상품 (supplements)

`supplementProducts` 배열 기반. `optionGroup1`, `optionName1`, `optionPrice`, `stockQuantity` 포함.

> 상품 파일의 `stockQuantity`는 옵션 + 추가상품 전체 재고 합산값입니다.

---

## 상품 상태 코드

| 상태 | 의미 |
|------|------|
| `success` | 정상 수집 |
| `paused` | 판매중지 (`SUSPENSION`) |
| `deleted` | 상품 삭제 (API 빈 응답 / 캐시 히트) |
| `soldout` | 재고 소진 (`OUTOFSTOCK`) |
| `error` | 네트워크 오류 / URL 오류 등 |

---

## 설치

```
1. chrome://extensions/ 접속
2. 개발자 모드 ON
3. "압축해제된 확장프로그램을 로드합니다" 클릭
4. naver-products/ 폴더 선택
```

난독화 빌드는 리포지토리 루트의 `build.js`를 사용합니다. 자세한 내용은 [루트 README](../README.md) 참조.

---

## 사용 방법

### 수집 탭

1. **📂 파일 로드** 로 `.txt` 파일을 불러오거나, URL을 직접 붙여넣습니다.  
   (한 줄에 하나씩, `smartstore.naver.com` / `brand.naver.com` URL만 인식)
2. **🚀 수집 시작** 클릭 → 진행 상황이 프로그레스 바로 표시됩니다.
3. 수집 완료 후 **💾 CSV 저장** (또는 JSON) 클릭.
4. 수집 중 **⏹ 즉시 중단** 을 누르면 처리 완료된 항목만 저장 가능합니다.

### 설정 탭

| 항목 | 설명 |
|------|------|
| 📁 기본 URL 파일 | 팝업 열릴 때마다 자동 로드할 `.txt` 파일 지정 |
| 💾 내보내기 설정 | CSV / JSON 선택, 자동 저장, 파일 이름 접두어 설정 |
| ⏱ 요청 딜레이 | 상품 간 랜덤 대기시간 범위 (초 단위, 기본 1.2 ~ 2.2초) |
| ⏰ 스케줄 수집 | 매일 지정 시각에 기본 URL 파일 자동 수집 |
| 💬 Slack 알림 | 수집 완료 시 결과 요약 + 파일을 Slack 채널로 전송 |
| 🌐 프록시 설정 | `IP:포트:아이디:비밀번호` 형식, N 요청 / N 오류마다 자동 교체 |
| 🔧 설정 관리 | 전체 설정 JSON 내보내기 / 불러오기 (업데이트 후 복원용) |

---

## 주요 기능

### 채널 정보 5단계 폴백

동일 스토어의 반복 요청을 최소화합니다.

```
1. 런타임 인메모리 캐시 (같은 수집 세션 내 재사용)
2. channels.json 로컬 파일 (사전 빌드 캐시)
3. chrome.storage.local 영구 캐시 (자동 학습)
4. 데스크탑 API 직접 호출
5. 모바일 API 직접 호출
```

### 삭제 상품 캐시

같은 URL 파일로 반복 수집 시 `deleted` 확정된 상품 ID를 기억해 HTTP 요청 없이 즉시 처리합니다. URL 파일이 바뀌면 캐시가 자동 초기화됩니다.

### 캡챠 대응

API 호출 실패 시 해당 URL을 활성 탭으로 열어 사용자에게 캡챠 해결 기회를 제공합니다. 프록시가 설정된 경우 캡챠 감지 시 자동으로 다음 프록시로 교체 후 재시도합니다.

### 스케줄 수집

`chrome.alarms` 기반으로 매일 지정 시각에 기본 URL 파일을 자동 수집하고 Slack으로 결과를 전송합니다. 브라우저가 실행 중일 때만 동작합니다.

### Slack 알림

수집 완료 후 결과 요약 메시지와 CSV / JSON 파일을 Slack 채널로 전송합니다. CSV의 경우 상품 / 옵션 / 추가상품 최대 3개 파일이 단일 메시지에 첨부됩니다.

---

## 파일 구조

```
naver-products/
├── manifest.json       확장 프로그램 설정
├── background.js       Service Worker — API 수집, 프록시, 스케줄, Slack
├── popup.html          팝업 UI 구조
├── popup.css           스타일 (네이버 그린 테마)
├── popup.js            팝업 이벤트 처리 및 설정 관리
├── channels.json       채널 UID 사전 캐시
├── icons/              icon16 / icon48 / icon128 PNG
└── README.md
```
