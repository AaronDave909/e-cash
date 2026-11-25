import { envInt, listen } from "@ecash/common";
import { buildApp } from "./app";

buildApp()
  .then((app) => listen(app, envInt("PORT", 8083)))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
