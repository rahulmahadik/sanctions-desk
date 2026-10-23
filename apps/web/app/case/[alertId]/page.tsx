import { CaseView } from "../../../components/CaseView";

export default async function CasePage({ params }: { params: Promise<{ alertId: string }> }) {
  const { alertId } = await params;
  return <CaseView alertId={alertId} />;
}
