# Sécurité · Security

## Signaler une faille

**N'ouvrez pas d'issue publique.** Utilisez le signalement privé de GitHub : onglet **Security** du dépôt →
**Report a vulnerability**. Décrivez la faille, comment la reproduire et son impact.

Nous accusons réception sous 72 heures et vous tenons informé·e jusqu'à la correction. Une fois corrigée, la faille
est publiée dans un avis de sécurité, avec vos remerciements si vous le souhaitez.

## Versions suivies

Seule la dernière version de la branche `main` reçoit des correctifs de sécurité pour l'instant.

## Bonnes pratiques d'hébergement

- Exposez Swiftma uniquement en **HTTPS** (profil `https` de docker compose) avec `SWIFTMA_SECURE_COOKIES=1`.
- Fermez les inscriptions (`SWIFTMA_SIGNUP=closed`) si seules des personnes invitées doivent entrer.
- Ne publiez pas le port 4000 directement sur Internet derrière le proxy.
- Sauvegardez le volume `/data` (base SQLite) régulièrement.
- Traitez les jetons d'accès (`swiftma_…`) et les liens de réinitialisation comme des mots de passe.

---

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting: the repository's **Security** tab →
**Report a vulnerability**. We acknowledge reports within 72 hours and keep you informed until a fix ships. Only
the latest `main` currently receives security fixes. When self-hosting:

- serve Swiftma over HTTPS only, with `SWIFTMA_SECURE_COOKIES=1`;
- close sign-ups if needed;
- keep port 4000 private;
- back up `/data`.
