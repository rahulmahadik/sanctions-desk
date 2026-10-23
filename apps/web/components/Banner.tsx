/** Always visible: the desk recommends, a person decides. */
export function HumanBanner({ sampleMode, notice }: { sampleMode?: boolean; notice?: string }) {
  return (
    <>
      <p className="banner" role="note">
        The desk only recommends. A person makes every decision; nothing here blocks an account, writes to a source
        system or contacts a customer.
      </p>
      {sampleMode ? (
        <p className="banner" role="note">
          Sample mode: the data is replayed from saved real answers and the model is a labelled rules-based stand-in.
          {notice ? ` ${notice}` : ""}
        </p>
      ) : null}
    </>
  );
}
