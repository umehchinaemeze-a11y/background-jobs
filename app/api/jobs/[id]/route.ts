import { authenticate } from "@/lib/auth";
import { apiJson, handleApiError } from "@/lib/api";
import { getJobStatus } from "@/lib/jobs";

// GET /api/jobs/:id — status of one of the caller's jobs. Missing jobs and
// jobs owned by another user both resolve to 404 (no existence leak).
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const principal = authenticate(request);
    const { id } = await params;
    const job = await getJobStatus(principal.userId, id);
    return apiJson({ data: job });
  } catch (e) {
    return handleApiError(e);
  }
}