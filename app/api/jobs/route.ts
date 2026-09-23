import { JobStatus } from "@prisma/client";
import { authenticate } from "@/lib/auth";
import { apiJson, handleApiError } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { enqueueJob, listJobs } from "@/lib/jobs";
import { enqueueBodySchema } from "@/lib/payload";

// POST /api/jobs — enqueue a job. Returns 202 Accepted immediately; the email
// work is performed later by the separate worker process.
export async function POST(request: Request) {
  try {
    const principal = authenticate(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiError(400, "Request body must be valid JSON");
    }

    const parsed = enqueueBodySchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ApiError(
        400,
        first ? `${first.path.join(".")}: ${first.message}` : "Invalid request",
      );
    }

    const result = await enqueueJob(principal.userId, parsed.data);
    return apiJson({ data: result }, 202);
  } catch (e) {
    return handleApiError(e);
  }
}

// GET /api/jobs?status=<JobStatus> — list the caller's jobs (used by the
// dead-letter view with status=dead).
export async function GET(request: Request) {
  try {
    const principal = authenticate(request);
    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");

    let status: JobStatus | undefined;
    if (statusParam) {
      if (!Object.values(JobStatus).includes(statusParam as JobStatus)) {
        throw new ApiError(400, `Invalid status: ${statusParam}`);
      }
      status = statusParam as JobStatus;
    }

    const parsedLimit = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 50;

    const jobs = await listJobs(principal.userId, status, limit);
    return apiJson({ data: jobs });
  } catch (e) {
    return handleApiError(e);
  }
}