import { createWorkerClient } from "../../../src/client.ts";
import type { Action, Context, TodoDerived, TodoState } from "../shared.ts";

const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});

const client = createWorkerClient<Action, Context>({
  emit: (message) => worker.postMessage(message),
  sanitizeAction: (action) => action,
  restoreContext: (data) => data as Context,
});

worker.addEventListener("message", (event) => client.receive(event.data));

/** Decode the current JSON file bytes into a TodoState. An empty file (fresh) means an empty list. */
function decodeDatabase(bytes: Uint8Array): TodoState {
  if (bytes.byteLength === 0) {
    return { todos: [] };
  }
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as TodoState;
}

/** Decode the derived index bytes. An empty derived (fresh) means an empty index. */
function decodeDerived(bytes: Uint8Array): TodoDerived {
  if (bytes.byteLength === 0) {
    return { total: 0, done: 0, open: 0, byId: {} };
  }
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as TodoDerived;
}

const form = document.querySelector<HTMLFormElement>("#todo-form")!;
const input = document.querySelector<HTMLInputElement>("#todo-input")!;
const list = document.querySelector<HTMLUListElement>("#todo-list")!;
const summary = document.querySelector<HTMLParagraphElement>("#todo-summary")!;

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  client.dispatch({
    kind: "AddTodo",
    id: crypto.randomUUID(),
    text,
  });
  input.value = "";
});

list.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const li = target.closest<HTMLLIElement>("[data-id]");
  if (!li) return;
  const id = li.dataset.id!;
  if (target.closest<HTMLElement>("[data-action='delete']")) {
    client.dispatch({ kind: "DeleteTodo", id });
  } else {
    client.dispatch({ kind: "ToggleTodo", id });
  }
});

client.subscribeDatabase((bytes) => {
  render(decodeDatabase(bytes));
});

// The derived index is delivered with every database snapshot, so the summary
// always reflects the same state — including optimistic (pending) changes.
client.subscribeDerived((bytes) => {
  renderSummary(decodeDerived(bytes));
});

function render(state: TodoState): void {
  list.replaceChildren(
    ...state.todos.map((todo) => {
      const li = document.createElement("li");
      li.dataset.id = todo.id;
      li.className = todo.done ? "done" : "";

      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = todo.done;
      label.append(checkbox, document.createTextNode(todo.text));

      const del = document.createElement("button");
      del.dataset.action = "delete";
      del.textContent = "✕";

      li.append(label, del);
      return li;
    }),
  );
}

function renderSummary(derived: TodoDerived): void {
  summary.textContent = `${derived.open} open · ${derived.done} done · ${derived.total} total`;
}

void client.ready().then(() => {
  (window as any).__syncReady = true;
  (window as any).__client = client;
  render(decodeDatabase(client.getDatabase()));
  const derived = client.getDerived();
  if (derived !== null) {
    renderSummary(decodeDerived(derived));
  }
});
