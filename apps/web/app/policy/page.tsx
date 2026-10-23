import { PolicyStudio } from "../../components/PolicyStudio";

export default function PolicyPage() {
  return (
    <>
      <h2>Policy Studio</h2>
      <p className="muted">
        How much a person does, and who changed what. A change is a draft, previewed on the exam, then published by a
        different policy admin.
      </p>
      <PolicyStudio />
    </>
  );
}
