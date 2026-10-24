# 실제 API 테스트

`index.html`을 실제 브라우저(Playwright)로 띄워 **실제 Google·xAI·OpenAI API**로 기능을 차례로 확인합니다.

## 준비
- API 키는 **환경 변수**로만 넣습니다(채팅·파일에 붙여넣지 마세요).
  - `GOOGLE_API_KEY`(또는 `GEMINI_API_KEY`) · `XAI_API_KEY` · `OPENAI_API_KEY`
  - 키가 없는 공급자의 테스트는 건너뜁니다.
- 네트워크에서 `generativelanguage.googleapis.com`, `api.x.ai`, `api.openai.com`, `unpkg.com` 접속이 허용돼야 합니다.
- Playwright가 필요합니다(Claude Code 클라우드 세션에는 기본 설치).

## 실행
```bash
node tests/real-api-e2e.js          # 계획과 예상 비용만 보여 줌(과금 없음)
node tests/real-api-e2e.js --yes    # 실제 실행(요금 발생)
node tests/real-api-e2e.js --mock   # 가짜 응답으로 스크립트만 점검(과금 없음)
```

선택 환경 변수
| 변수 | 설명 |
|---|---|
| `ONLY=google,xai,openai` | 공급자 한정 |
| `MODELS=nanobanana2_1,grok_imagine_2` | 모델별 생성 테스트 대상(앱의 모델 키) |
| `INCLUDE_BATCH=1` | Batch 제출 후 바로 취소까지 확인 |
| `COMPARE_TURBO=1` | 나노바나나 2.1 초고속 모드 켬/끔 시간·사고 토큰 비교(2장 추가) |
| `TEST_TIMEOUT_SEC=240` | 요청 1건 대기 상한 |
| `LOCAL_DEPS_DIR=…/node_modules` | `unpkg.com`이 막힌 환경에서 React·pdf.js·fflate를 로컬에서 제공 |

## 확인 항목
- 공급자별 연결 테스트(무료)
- 모델별 1K 1장 생성(나노바나나 2.1·2 Lite·2·프로·1, Grok 2.0·1.0, GPT Image 2.5 Sunburst·Flare·2): 실제 청구액, 초고속 모드(사고 MINIMAL·JPEG 수신)
- 문서: PDF 글자 추출, DOCX 참조 생성, 이전 문서 함께 보내기, 문서 분석(사고 끔), 스캔 PDF 글자 읽기
- 마스크 편집(나노바나나·GPT Image 공식 mask), 다중 이미지 개별 편집
- 프롬프트·첨부 수정 후 재생성(이미지 삭제·문서 추가·마스크 칠하기)
- Grok 문서 참조 시 프롬프트 7,000자 상한 준수

모든 생성은 1K · 1장 · 절약 모드 · GPT/Grok quality low로 요청해 비용을 최소화합니다.
결과는 `tests/output/real-api-report.md`(키는 가려짐)와 실패 시 스크린샷으로 남습니다.
