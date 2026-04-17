# Linkmerce Extensions

> Linkmerce 프로젝트를 보조하는 크롬 확장프로그램 모음

## 확장 프로그램 목록

| 폴더 | 이름 | 설명 | 버전 |
|------|------|------|------|
| [`google-search/`](google-search/) | 구글 검색 자동화 | 여러 키워드를 순차 검색하여 결과(query, rank, title, URL, snippet)를 CSV / JSON으로 자동 수집. CAPTCHA 대기 및 이어서 수집 지원. | v0.3.1 |
| [`naver-cookies/`](naver-cookies/) | 네이버 쿠키 업데이트 | 네이버 세션 쿠키를 주기적으로 추출하여 Slack 채널에 텍스트 파일로 업로드. Linux 서버(Airflow)에서 네이버 인증이 필요할 때 사용. | v0.2.2 |
| [`naver-products/`](naver-products/) | 네이버 상품 ETL | 네이버 스마트스토어 / 브랜드스토어 상품 URL을 대량 입력하여 가격, 재고, 리뷰, 옵션 데이터를 CSV / JSON으로 자동 수집. | v3.4.8 |

## 설치 (개발 버전)

각 확장 프로그램 폴더를 크롬에 직접 로드합니다.

```
1. chrome://extensions/ 접속
2. 개발자 모드 ON
3. "압축해제된 확장프로그램을 로드합니다" 클릭
4. 원하는 확장 프로그램 폴더 선택
   - google-search/
   - naver-cookies/
   - naver-products/
```

## 난독화 빌드

배포용 난독화 빌드를 생성합니다. 확장 프로그램의 JS/HTML/CSS/JSON을 난독화·압축하여 `dist/` 폴더에 출력합니다.

### 의존 패키지 설치 (최초 1회)

```bash
npm install
```

### 빌드

폴더명을 매개변수로 지정합니다.

```bash
node build.js google-search
node build.js naver-cookies
node build.js naver-products
```

### 빌드 결과

```
dist/
├── google-search/      google-search 난독화 결과물
├── naver-cookies/      naver-cookies 난독화 결과물
└── naver-products/     naver-products 난독화 결과물
```

| 처리 | 도구 |
|------|------|
| JS 난독화 | `javascript-obfuscator` |
| HTML 압축 | `html-minifier-terser` |
| CSS 압축 | `clean-css` |
| JSON 공백 제거 | `JSON.parse` + `JSON.stringify` |
| 그 외 (PNG 등) | 파일 그대로 복사 |

빌드 후 `dist/<이름>/` 폴더를 크롬에 로드하거나 ZIP으로 압축해 배포합니다.

## 프로젝트 구조

```
linkmerce-extensions/
├── google-search/          구글 검색 자동화
│   ├── manifest.json
│   ├── background.js
│   ├── content_script.js
│   ├── popup.html / popup.css / popup.js
│   ├── icons/
│   └── README.md
├── naver-cookies/          네이버 쿠키 업데이트
│   ├── manifest.json
│   ├── background.js
│   ├── popup.html / popup.css / popup.js
│   ├── icons/
│   └── README.md
├── naver-products/         네이버 상품 ETL
│   ├── manifest.json
│   ├── background.js
│   ├── popup.html / popup.css / popup.js
│   ├── icons/
│   └── README.md
├── dist/                   난독화 빌드 결과물 (빌드 후 생성)
├── build.js                난독화 빌드 스크립트
├── package.json            Node.js 개발 의존성
└── README.md
```
