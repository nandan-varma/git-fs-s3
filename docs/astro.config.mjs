// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	site: 'https://nandan-varma.github.io',
	base: '/git-fs-s3',
	integrations: [
		starlight({
			title: 'git-fs-s3',
			tagline: 'Run git repositories on serverless platforms — no disk, no git binary.',
			description:
				'An isomorphic-git filesystem backend for S3-compatible object storage (AWS S3, Cloudflare R2, MinIO). Includes a smart-HTTP protocol handler and a higher-level git-hosting operations layer.',
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/nandan-varma/git-fs-s3',
				},
			],
			editLink: {
				baseUrl: 'https://github.com/nandan-varma/git-fs-s3/edit/main/docs/',
			},
			customCss: ['./src/styles/custom.css'],
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'Introduction', slug: 'index' },
						{ label: 'Getting started', slug: 'getting-started' },
						{ label: 'Semantics & limitations', slug: 'semantics-and-limitations' },
						{ label: 'Roadmap', slug: 'roadmap' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'The ObjectStore interface', slug: 'guides/object-store' },
						{ label: 'The production stack', slug: 'guides/production-stack' },
						{ label: 'Caching', slug: 'guides/caching' },
						{ label: 'Retry & circuit breaker', slug: 'guides/retry-and-circuit-breaker' },
					],
				},
				{
					label: 'Git smart-HTTP (/http)',
					items: [
						{ label: 'Overview', slug: 'http/overview' },
						{ label: 'Serving clones and pushes', slug: 'http/serving-clones-and-pushes' },
						{ label: 'Repacking', slug: 'http/repacking' },
					],
				},
				{
					label: 'App-layer operations (/ops)',
					items: [
						{ label: 'Overview', slug: 'ops/overview' },
						{ label: 'Branches & commits', slug: 'ops/branches-and-commits' },
						{ label: 'Trees, history & diff', slug: 'ops/trees-history-and-diff' },
						{ label: 'Merge', slug: 'ops/merge' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Root export', slug: 'reference' },
						{ label: '/s3', slug: 'reference/s3' },
						{ label: '/http', slug: 'reference/http' },
						{ label: '/ops', slug: 'reference/ops' },
					],
				},
			],
		}),
	],
});
