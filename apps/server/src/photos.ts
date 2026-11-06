// Proxy Pexafy pour la recherche et l'insertion de photos libres de droits
// (Unsplash, Pexels, Pixabay, etc.) sans exposer la clé API au navigateur client.

import type { Request, Response } from "express";

const PEXAFY_BASE_URL = (process.env.PEXAFY_BASE_URL ?? "https://api.pexafy.com").replace(/\/+$/, "");

export interface NormalizedPhoto {
  id: string;
  url: string;
  thumbnail: string;
  title: string;
  credit: string;
  photographer: string;
  source: string;
  sourcePageUrl?: string | null;
  width?: number | null;
  height?: number | null;
  orientation?: string;
  color?: string;
}

/** Statut de la configuration Pexafy. */
export function getPhotosStatus(_req: Request, res: Response) {
  const configured = !!(process.env.PEXAFY_API_KEY && process.env.PEXAFY_API_KEY.trim());
  res.json({
    ok: true,
    configured,
    provider: "pexafy",
    message: configured
      ? "Pexafy API configurée (Unsplash, Pexels, Pixabay réunis)."
      : "Pexafy API non configurée. Définissez la variable PEXAFY_API_KEY pour activer la recherche complète sur 9M+ photos.",
  });
}

/** Recherche de photos via l'API Pexafy (ou fallback Openverse si aucune clé n'est configurée). */
export async function searchPhotos(req: Request, res: Response) {
  const q = String(req.query.q ?? req.query.query ?? "").trim();
  const orientation = req.query.orientation ? String(req.query.orientation).trim() : undefined;
  const count = Math.min(30, Math.max(1, parseInt(String(req.query.per_page ?? req.query.count ?? "18"), 10) || 18));

  const apiKey = process.env.PEXAFY_API_KEY?.trim();

  // 1. Si la clé Pexafy est configurée : appel à l'API Pexafy
  if (apiKey) {
    try {
      const url = new URL(`${PEXAFY_BASE_URL}/api/v1/search/photos`);
      url.searchParams.set("q", q || "architecture modern minimal");
      url.searchParams.set("per_page", String(count));
      if (orientation && ["landscape", "portrait", "square"].includes(orientation)) {
        url.searchParams.set("orientation", orientation);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const upstream = await fetch(url.toString(), {
        headers: {
          "x-api-key": apiKey,
          accept: "application/json",
          "user-agent": "Swiftma-Proxy/1.0",
        },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!upstream.ok) {
        const errorBody = (await upstream.json().catch(() => ({}))) as any;
        const detail = errorBody?.error?.message ?? errorBody?.detail ?? upstream.statusText;
        return res.status(upstream.status).json({
          ok: false,
          error: `Pexafy: ${detail} (${upstream.status})`,
        });
      }

      const body = (await upstream.json()) as { success?: boolean; data?: any[] };
      const rawList = Array.isArray(body.data) ? body.data : [];

      const photos: NormalizedPhoto[] = rawList.map((item) => {
        const urls = item.urls ?? {};
        const photographer = item.photographer_full_name || item.photographer_username || item.photographer || "";
        const source = item.source || "Pexafy";
        const title = item.alt_description || item.description || item.source_description || "Photo";
        const credit = item.attribution?.plain || (photographer ? `Photo by ${photographer} on ${source}` : `Photo sur ${source}`);

        return {
          id: item.photo_id ?? String(item.id ?? ""),
          url: urls.regular || item.image_url || urls.full || urls.small || "",
          thumbnail: urls.small || urls.thumb || item.image_url || urls.regular || "",
          title,
          credit,
          photographer,
          source,
          sourcePageUrl: item.source_image_url ?? null,
          width: item.width ?? null,
          height: item.height ?? null,
          orientation: item.orientation ?? "",
          color: item.color_hex ?? "",
        };
      });

      return res.json({
        ok: true,
        provider: "pexafy",
        configured: true,
        count: photos.length,
        photos,
      });
    } catch (err) {
      console.error("[Pexafy Proxy Error]", err);
      return res.status(502).json({
        ok: false,
        error: `Erreur de communication avec Pexafy : ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 2. Mode Démo / Fallback sans clé Pexafy : Openverse (Creative Commons)
  try {
    const query = q || "nature";
    const openverseUrl = new URL("https://api.openverse.org/v1/images/");
    openverseUrl.searchParams.set("q", query);
    openverseUrl.searchParams.set("page_size", String(count));
    openverseUrl.searchParams.set("license_type", "commercial");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const openverseRes = await fetch(openverseUrl.toString(), {
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!openverseRes.ok) {
      throw new Error(`Openverse HTTP ${openverseRes.status}`);
    }

    const ovData = (await openverseRes.json()) as { results?: any[] };
    const ovItems = Array.isArray(ovData.results) ? ovData.results : [];

    const photos: NormalizedPhoto[] = ovItems.map((p) => ({
      id: String(p.id ?? ""),
      url: p.url || p.thumbnail,
      thumbnail: p.thumbnail || p.url,
      title: p.title || "Photo",
      credit: `${p.title || "Photo"} — ${p.creator || "Auteur inconnu"} (${(p.license || "CC").toUpperCase()})`,
      photographer: p.creator || "Auteur inconnu",
      source: "Openverse",
      sourcePageUrl: p.foreign_landing_url ?? null,
      width: p.width ?? null,
      height: p.height ?? null,
      orientation: undefined,
      color: undefined,
    }));

    return res.json({
      ok: true,
      provider: "openverse-fallback",
      configured: false,
      message: "Pour débloquer Unsplash, Pexels et Pixabay réunis en haute résolution, configurez PEXAFY_API_KEY sur votre instance.",
      count: photos.length,
      photos,
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: `Service de recherche indisponible : ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
