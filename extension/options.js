const $ = (id) => document.getElementById(id);
browser.storage.local.get({ port: 8765, token: "" }).then((c) => {
  $("port").value = c.port;
  $("token").value = c.token;
});
$("save").addEventListener("click", async () => {
  await browser.storage.local.set({
    port: parseInt($("port").value, 10) || 8765,
    token: $("token").value.trim(),
  });
  $("st").textContent = "Salvato. Il collegamento riparte da solo.";
});
