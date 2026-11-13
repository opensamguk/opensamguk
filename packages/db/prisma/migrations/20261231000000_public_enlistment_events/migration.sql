ALTER TABLE "PublicNationEvent" DROP CONSTRAINT "PublicNationEvent_kind_check";
ALTER TABLE "PublicNationEvent" ADD CONSTRAINT "PublicNationEvent_kind_check"
  CHECK ("kind" IN ('found', 'fall', 'declare', 'capture', 'promotion', 'enlist'));
