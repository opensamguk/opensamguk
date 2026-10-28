-- 발행한 문서의 종류·판마다 본문 해시와 시행일을 고정한다.
CREATE TABLE "LegalDocumentVersion" (
    "docType" "ConsentDocType" NOT NULL,
    "version" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "bodySha256" TEXT NOT NULL,
    CONSTRAINT "LegalDocumentVersion_pkey" PRIMARY KEY ("docType", "version"),
    CONSTRAINT "LegalDocumentVersion_bodySha256_check" CHECK ("bodySha256" ~ '^[0-9a-f]{64}$')
);
