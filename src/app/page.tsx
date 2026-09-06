import { redirect } from "next/navigation";

/**
 * The root is an entrance, not a destination.
 *
 * `/app` is the only thing this project does, and it already resolves both
 * cases on its own: it renders the authenticated view for a signed-in visitor
 * and redirects a signed-out one to `/sign-in`. A landing page in front of
 * that would be a third surface that has to answer the same question those two
 * already answer between them, so `/` forwards rather than deciding.
 *
 * What stood here was the tracer-bullet harness from ADR-0001 -- a button that
 * emitted a ping and logged the reply to the console. It proved the socket
 * shared an origin with the page back when nothing else did; the running
 * application has proved that continuously ever since, so the harness was
 * evidence for a claim no longer in doubt.
 */
export default function Home() {
  redirect("/app");
}
