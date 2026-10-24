-- Public form links: a ShareLink may publish one FORM view instead of the
-- whole database page. Deleting the view deletes its public link.
ALTER TABLE "ShareLink" ADD COLUMN "viewId" TEXT;

CREATE INDEX "ShareLink_viewId_idx" ON "ShareLink"("viewId");

ALTER TABLE "ShareLink"
ADD CONSTRAINT "ShareLink_viewId_fkey"
FOREIGN KEY ("viewId") REFERENCES "DatabaseView"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
