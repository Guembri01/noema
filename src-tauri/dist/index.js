      // `withGlobalTauri` is off, so the global API object is not on the
      // window: the app binds through `@tauri-apps/api`, and this page — which
      // has no build step and therefore no import — talks to the very transport
      // the package itself uses: the internals the shell installs in every
      // document it hosts. Which commands may be called is still decided by the
      // capabilities, not by this page.
      const internals = window.__TAURI_INTERNALS__ || null;
      const detail = document.getElementById("detail");
      const title = document.getElementById("title");
      const lead = document.getElementById("lead");
      const root = document.documentElement;

      async function invoke(command, args) {
        if (!internals) throw new Error("The native bridge is unavailable.");
        return internals.invoke(command, args);
      }

      // The event plugin of the same package: the callback is registered with
      // the shell and the listener is bound to the event name.
      function listen(name, handler) {
        if (!internals) return null;
        const id = internals.transformCallback(handler);
        return internals.invoke("plugin:event|listen", {
          event: name,
          target: { kind: "Any" },
          handler: id,
        });
      }

      function showFailure(message) {
        root.dataset.state = "failed";
        title.textContent = "Noema could not start";
        lead.textContent =
          "The local server did not become ready. Check the database connection below, then retry.";
        detail.textContent = message || "";
        document.getElementById("advanced").open = true;
      }

      function showReady(info) {
        root.dataset.state = "ready";
        title.textContent = "Noema is ready";
        lead.textContent = "Opening the workspace…";
        detail.textContent = "";
        if (info && info.api_base) window.location.replace(info.api_base);
      }

      if (internals) {
        // A refusal (the shell says no) must not break the page: the status
        // line then stays as it is.
        void Promise.resolve(
          listen("sidecar://event", (event) => {
            const payload = (event && event.payload) || {};
            if (payload.kind === "ready") showReady(payload.info);
            else if (payload.kind === "failed") showFailure(payload.message);
            else if (payload.kind === "crashed" && !payload.will_restart) {
              showFailure("The server stopped unexpectedly (code " + payload.code + ").");
            } else if (payload.kind === "starting") {
              root.dataset.state = "starting";
              title.textContent = "Noema is starting…";
            }
          }),
        ).catch(() => {});
      }

      document.getElementById("save").addEventListener("click", async () => {
        const url = document.getElementById("db").value.trim();
        if (!url) {
          detail.textContent = "Paste a connection string first.";
          return;
        }
        detail.textContent = "Restarting the server with the new connection…";
        try {
          const info = await invoke("set_database_url", { url });
          showReady(info);
        } catch (error) {
          showFailure(String(error));
        }
      });

      document.getElementById("retry").addEventListener("click", async () => {
        detail.textContent = "Restarting the server…";
        try {
          const info = await invoke("restart_server");
          showReady(info);
        } catch (error) {
          showFailure(String(error));
        }
      });

      document.getElementById("reveal").addEventListener("click", async () => {
        try {
          await invoke("open_data_dir");
        } catch (error) {
          detail.textContent = String(error);
        }
      });

      document.getElementById("logs").addEventListener("click", async () => {
        try {
          const info = await invoke("desktop_info");
          const lines = await invoke("recent_logs", { limit: 60 });
          await navigator.clipboard.writeText(
            JSON.stringify(info, null, 2) + "\n\n" + (lines || []).join("\n"),
          );
          detail.textContent = "Diagnostics copied to the clipboard (password redacted).";
        } catch (error) {
          detail.textContent = String(error);
        }
      });

      // The shell may already be past "starting" by the time this page loads.
      invoke("desktop_info")
        .then((info) => {
          if (info && info.ready) showReady(info);
          else if (info && info.database_url) document.getElementById("db").placeholder = info.database_url;
        })
        .catch(() => {});
