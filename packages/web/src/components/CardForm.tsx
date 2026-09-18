import { useState, type FormEvent } from "react";

interface CardFormProps {
  onCreate: (title: string) => Promise<void>;
}

export function CardForm({ onCreate }: CardFormProps) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const trimmedTitle = title.trim();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmedTitle || submitting) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onCreate(trimmedTitle);
      setTitle("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create card");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="compose" onSubmit={handleSubmit}>
      {/* A card is always created into Backlog, whichever status is on screen,
          so the label says where it lands rather than leaving it to be found. */}
      <label className="compose__label" htmlFor="new-card-title">
        Add a card to Backlog
      </label>
      <div className="compose__row">
        <input
          id="new-card-title"
          className="compose__input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={submitting}
        />
        <button type="submit" className="compose__submit" disabled={!trimmedTitle || submitting}>
          Add card
        </button>
      </div>
      {error ? (
        <p className="compose__error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
