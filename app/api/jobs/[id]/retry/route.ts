import { authenticate } from "@/lib/auth";
import { apiJson, handleApiError } from "@/lib/api";
import { retryDeadJob } from "@/lib/jobs";

// POST /api/jobs/:id/retry — manual dead-letter retry (dead -> pending with a
// fresh attempt cycle). Only the owning user may retry.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const principal = authenticate(request);
    const { id } = await params;
    const job = await retryDeadJob(principal.userId, id);
    return apiJson({ data: job });
  } catch (e) {
    return handleApiError(e);
  }
}