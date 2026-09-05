const button = document.querySelector("#add-note");
button.addEventListener("click", () => {
  const note = document.createElement("article");
  const title = document.createElement("h2");
  title.textContent = "Your next idea starts here.";
  const detail = document.createElement("p");
  detail.textContent = "This interactive prototype runs in the browser.";
  note.append(title, detail);
  document.querySelector("#notes").append(note);
  document.querySelector("#status").textContent = "A new note is ready.";
});
