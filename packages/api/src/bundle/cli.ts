import path from "node:path";
import { bundleApi } from "./bundle";

await bundleApi(path.join(import.meta.dirname, "..", "..", "dist"));
