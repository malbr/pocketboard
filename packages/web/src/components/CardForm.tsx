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
    <form onSubmit={handleSubmit}>
      <label htmlFor="new-card-title">New card title</label>
      <input
        id="new-card-title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        disabled={submitting}
      />
      <button type="submit" disabled={!trimmedTitle || submitting}>
        Add card
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}
