# Buffer-backed publishing in self-hosted Postiz v2.26.0

Custom integration for a single configured Postiz workspace and Buffer organization, not an official connector. Existing direct providers, database schema and Temporal workflow versions are unchanged. Do not replace the running installation until build and staging checks pass.

## 1. Prepare Buffer

Connect the owned X account, LinkedIn company Page (not personal profile), and TikTok account in Buffer. Confirm automatic publishing is available on your plan. Generate a personal API key with account/channel read, posts read and posts write access. Never commit or share the key.

Clone the branch into a fresh directory outside the live Dockge stack:

    git clone --single-branch --branch feature/buffer-publishing-v2.26.0 https://github.com/BulwarkProtection/bulwark-postiz.git bulwark-postiz-buffer
    cd bulwark-postiz-buffer
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/buffer-discover.ps1

The script prompts privately for the key and retrieves organization/channel IDs and connection statuses without posting. Record the intended IDs. LinkedIn must have service linkedin and type page; X is twitter and TikTok is tiktok.

Find the Postiz workspace ID with a read-only Prisma query in CMD:

    docker exec -w /app postiz node -e "const {PrismaClient}=require('@prisma/client'); const db=new PrismaClient(); db.organization.findMany({where:{deletedAt:null},select:{id:true,name:true}}).then(x=>console.table(x)).catch(()=>{console.error('Workspace lookup failed');process.exitCode=1}).finally(()=>db['$disconnect']())"

## 2. Build and test without changing production

In the cloned repository:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/buffer-build.ps1

The script identifies the live image, preserves a rollback tag without overwriting a different existing tag, builds the upstream Dockerfile and runs the isolated Buffer tests in the built image. It does not restart or stop live containers. Record the exact new image tag it prints. Check that the running version is actually v2.26.0 (the official image was installed as latest). Never run docker compose down -v or prune the rollback image.

## 3. Local configuration

Back up the Dockge YAML and .env, PostgreSQL and Redis to a restricted location outside this repository. Verify Redis has a persistent data volume and persistence configuration (AOF recommended). Duplicate protection relies on retained Redis state. Do not change Redis storage settings blindly.

Add these entries in the existing postiz service's environment mapping. Preserve all current credentials, URLs, databases, volumes and ports.

    BUFFER_API_KEY: "${BUFFER_API_KEY:?Missing Buffer API key}"
    BUFFER_ORGANIZATION_ID: "${BUFFER_ORGANIZATION_ID:?Missing Buffer organization ID}"
    BUFFER_POSTIZ_ORGANIZATION_ID: "${BUFFER_POSTIZ_ORGANIZATION_ID:?Missing Postiz workspace ID}"
    BUFFER_X_CHANNEL_ID: "${BUFFER_X_CHANNEL_ID:-}"
    BUFFER_LINKEDIN_CHANNEL_ID: "${BUFFER_LINKEDIN_CHANNEL_ID:-}"
    BUFFER_TIKTOK_CHANNEL_ID: "${BUFFER_TIKTOK_CHANNEL_ID:-}"
    BUFFER_MEDIA_ORIGIN: "${BUFFER_MEDIA_ORIGIN:-}"

In the local .env, fill the following with actual values; the API key is private:

    BUFFER_API_KEY=
    BUFFER_ORGANIZATION_ID=
    BUFFER_POSTIZ_ORGANIZATION_ID=
    BUFFER_X_CHANNEL_ID=
    BUFFER_LINKEDIN_CHANNEL_ID=
    BUFFER_TIKTOK_CHANNEL_ID=
    BUFFER_MEDIA_ORIGIN=https://media.bulwarkprotection.com

Omit channel IDs for channels not yet connected. Missing config hides those providers. An empty media origin falls back to CLOUDFLARE_BUCKET_URL. The Buffer key remains in the local server environment; it never enters the browser or database channel token.

## 4. Staging and go-live

- Smoke test with separate staging PostgreSQL, Redis and Temporal namespace/instance. Do not run a second worker on the production schedule.
- Validate candidate Compose configuration. Set the Postiz service image to the exact bulwark-postiz:buffer-2.26.0-<commit> tag from the build script, not latest. Keep other services unchanged.
- Confirm login, direct providers, media library and calendar. Add X (via Buffer), LinkedIn Page (via Buffer), and TikTok (via Buffer) in Add Channel.
- Test explicitly approved sample content and verify Buffer sent status and actual social posts. Test photo/video retrieval from public R2, future scheduling, editing/canceling before due time, disconnected/paused channels and ambiguous outcomes.
- After staging passes, switch the existing Postiz service with the same data volumes and configuration. Keep the rollback image.

## Supported initial functionality and limits

Postiz retains the calendar and submits an automatic shareNow mutation at the chosen publication time. It polls until Buffer reports sent, not just accepted. Delivery may occur after the scheduled time. JPEG, PNG and MP4 from the configured public HTTPS media origin are supported: one video or up to 4 X photos, 9 LinkedIn photos or 10 TikTok photos (conservative integration limits). TikTok photo posts require a title. X and TikTok video expose AI-content disclosure.

Single posts only: no replies, threads, first comments, advanced settings or analytics. Edits or cancellation after submission to Buffer are not synchronized; inspect Buffer directly. Do not select both native and Buffer providers for the same social account in one scheduled post.

## Duplicate protection and rollback

A Redis receipt is claimed before the irreversible create mutation and the remote ID retained when available. Retries reuse the remote ID rather than submit again. Ambiguous creates block replay and require reconciliation with Buffer and the destination account. This depends on retained Redis state and is not a guarantee against data loss or deliberate replacement posts. Known validation rejections can be retried.

Before adding Buffer channels, restoring the original image/configuration is straightforward. After adding new provider records, cancel future Buffer schedules and disconnect/remove Buffer channels using the custom UI before rolling back; the older image does not understand those providers. Preserve backups and do not restore a database over new production data unless recovery is explicitly required.

## Validation

    node --test scripts/buffer-integration.test.cjs

Requires Node 22 and TypeScript. Tests use mocked API/Redis responses and cover media validation, workspace binding, auth state, duplicate protection, secret redaction and publishing status. Mock tests alone do not establish full application build success or live account integration. Full Docker build and live testing are required before production use.
