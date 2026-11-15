-- cityKey=0은 행군 고갈 뒤 위치 미지정이다. 나머지 위치는 기존 City FK로 검증한다.
ALTER TABLE "General" DROP CONSTRAINT "General_worldId_cityKey_fkey";
ALTER TABLE "General" ADD COLUMN "cityAnchorKey" INTEGER
  GENERATED ALWAYS AS (NULLIF("cityKey", 0)) STORED;
ALTER TABLE "General" ADD CONSTRAINT "General_worldId_cityKey_fkey"
  FOREIGN KEY ("worldId", "cityAnchorKey") REFERENCES "City"("worldId", "cityKey")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "General" ADD CONSTRAINT "General_cityKey_nonnegative" CHECK ("cityKey" >= 0);
