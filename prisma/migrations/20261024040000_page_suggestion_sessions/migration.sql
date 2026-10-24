-- Suggestions (track-changes) persistence: one committed base snapshot per page.
CREATE TABLE "PageSuggestionSession" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "base" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PageSuggestionSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PageSuggestionSession_pageId_key" ON "PageSuggestionSession"("pageId");

ALTER TABLE "PageSuggestionSession"
    ADD CONSTRAINT "PageSuggestionSession_pageId_fkey"
    FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;
