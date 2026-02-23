import { defineCollection, z } from 'astro:content';

const projects = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    domain: z.string(),
    stack: z.array(z.string()).optional().default([]),
    link: z.string().optional(),
    image: z.string().optional(),
    featured: z.boolean().optional().default(false),
  }),
});

const blog = defineCollection({
  type: 'content',
  schema: ({ image }) => z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    author: z.string().optional(),
    domain: z.string(),
    stack: z.array(z.string()).optional().default([]),
    image: z.object({
      src: image(),
      alt: z.string(),
    }).optional(),
  }),
});

export const collections = { projects, blog };
