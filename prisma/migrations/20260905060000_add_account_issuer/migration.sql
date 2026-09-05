-- better-auth 1.7 requires an `issuer` on account plus a unique (issuer, accountId).
ALTER TABLE "account" ADD COLUMN "issuer" TEXT NOT NULL DEFAULT '';
ALTER TABLE "account" ALTER COLUMN "issuer" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "account_issuer_accountId_key" ON "account"("issuer", "accountId");
