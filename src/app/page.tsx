import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { sitePath } from "@/lib/site-url";

export default async function Home() {
  const h = await headers();
  redirect(sitePath("/rooms", h));
}
