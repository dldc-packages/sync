import { createWorkerClient } from "../../../src/client.ts";
import type { Action, Context, TodoState } from "../shared.ts";

const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});

const client = createWorkerClient<Action, Context>({
  worker,
  sanitizeAction: (action) => action,
  restoreContext: (data) => data as Context,
});

/** Decode the current JSON file bytes into a TodoState. An empty file (fresh) means an empty list. */
function decodeDatabase(bytes: Uint8Array): TodoState {
  if (bytes.byteLength === 0) {
    return { todos: [] };
  }
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as TodoState;
}

const form = document.querySelector<HTMLFormElement>("#todo-form")!;
const input = document.querySelector<HTMLInputElement>("#todo-input")!;
const list = document.querySelector<HTMLUListElement>("#todo-list")!;

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

client.ready().then(() => {
  (window as any).__syncReady = true;
  render(decodeDatabase(client.getDatabase()));
});
