import 'dotenv/config';
import fs from 'fs';
import express from 'express';
import { google } from 'googleapis';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =====================================================
// CONFIG
// =====================================================

const cfg = {
  port: Number(process.env.PORT || 3000),

  base:
    process.env.BASE_URL ||
    process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : 'http://localhost:3000',

  handle: process.env.YOUTUBE_CHANNEL_HANDLE || '@KindCrafted-m4q',

  phrase:
    process.env.VERIFY_PHRASE ||
    'CRAFTED-MANAGER-VERIFY-2026',

  clientId: process.env.GOOGLE_CLIENT_ID,

  clientSecret: process.env.GOOGLE_CLIENT_SECRET,

  redirectUri:
    process.env.GOOGLE_REDIRECT_URI ||
    `${
      process.env.BASE_URL ||
      (process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : 'http://localhost:3000')
    }/oauth2callback`,

  geminiKey: process.env.GEMINI_API_KEY,

  geminiModel:
    process.env.GEMINI_MODEL ||
    'gemini-2.5-flash',

  postsPerDay: Math.max(
    1,
    Number(process.env.POSTS_PER_DAY || 2)
  ),

  tz:
    process.env.TIMEZONE ||
    'Pacific/Honolulu',

  sessionSecret:
    process.env.SESSION_SECRET ||
    'change-me'
};

// =====================================================
// DATABASE
// =====================================================

const dataDir = path.join(__dirname, 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, {
    recursive: true
  });
}

const databasePath = path.join(
  dataDir,
  'creator.db'
);

console.log(
  `[database] Opening database at ${databasePath}`
);

const db = new Database(databasePath);

db.exec(`
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handled_comments (
  comment_id TEXT PRIMARY KEY,
  action TEXT,
  reply TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS questions (
  comment_id TEXT PRIMARY KEY,
  author TEXT,
  text TEXT,
  video_id TEXT,
  video_title TEXT,
  created_at TEXT,
  status TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS performance (
  video_id TEXT,
  sampled_at TEXT,
  views INTEGER,
  likes INTEGER,
  comments INTEGER
);
`);

console.log('[database] Database ready');

const getKV = (k) =>
  db
    .prepare(
      'SELECT v FROM kv WHERE k=?'
    )
    .get(k)?.v;

const setKV = (k, v) =>
  db
    .prepare(`
      INSERT INTO kv(k,v)
      VALUES(?,?)
      ON CONFLICT(k)
      DO UPDATE SET v=excluded.v
    `)
    .run(k, String(v));

// =====================================================
// GOOGLE OAUTH
// =====================================================

function oauth() {
  return new google.auth.OAuth2(
    cfg.clientId,
    cfg.clientSecret,
    cfg.redirectUri
  );
}

function authed() {
  const o = oauth();

  const raw = getKV('tokens');

  if (!raw) {
    throw new Error(
      'YouTube not connected'
    );
  }

  const credentials =
    JSON.parse(raw);

  o.setCredentials(credentials);

  o.on('tokens', (tokens) => {
    const existing =
      JSON.parse(
        getKV('tokens') || '{}'
      );

    setKV(
      'tokens',
      JSON.stringify({
        ...existing,
        ...tokens
      })
    );
  });

  return o;
}

function yt() {
  return google.youtube({
    version: 'v3',
    auth: authed()
  });
}

// =====================================================
// GOOGLE LOGIN
// =====================================================

app.get(
  '/auth/google',
  (req, res) => {
    if (
      !cfg.clientId ||
      !cfg.clientSecret
    ) {
      return res
        .status(500)
        .send(
          'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.'
        );
    }

    const o = oauth();

    const authUrl =
      o.generateAuthUrl({
        access_type: 'offline',

        prompt: 'consent',

        scope: [
          'https://www.googleapis.com/auth/youtube.force-ssl',
          'https://www.googleapis.com/auth/youtube.readonly'
        ]
      });

    res.redirect(authUrl);
  }
);

app.get(
  '/oauth2callback',
  async (req, res) => {
    try {
      if (!req.query.code) {
        throw new Error(
          'Google did not return an authorization code.'
        );
      }

      const o = oauth();

      const { tokens } =
        await o.getToken(
          req.query.code
        );

      setKV(
        'tokens',
        JSON.stringify(tokens)
      );

      console.log(
        '[oauth] YouTube connected'
      );

      res.redirect(
        '/?connected=1'
      );
    } catch (error) {
      console.error(
        '[oauth]',
        error
      );

      res
        .status(500)
        .send(
          `YouTube connection failed: ${error.message}`
        );
    }
  }
);

// =====================================================
// YOUTUBE CHANNEL
// =====================================================

async function channelInfo() {
  const y = yt();

  const response =
    await y.channels.list({
      part: [
        'snippet',
        'statistics',
        'contentDetails'
      ],

      mine: true
    });

  const channel =
    response.data.items?.[0];

  if (!channel) {
    throw new Error(
      'No authorized YouTube channel found'
    );
  }

  return channel;
}

async function verifyDescription() {
  const channel =
    await channelInfo();

  const description =
    channel.snippet?.description ||
    '';

  return {
    ok: description.includes(
      cfg.phrase
    ),

    channel
  };
}

// =====================================================
// LOAD ALL CHANNEL VIDEOS
// =====================================================

async function allOwnedVideos() {
  const channel =
    await channelInfo();

  const uploads =
    channel.contentDetails
      .relatedPlaylists.uploads;

  let pageToken;

  const ids = [];

  do {
    const response =
      await yt().playlistItems.list({
        part: [
          'contentDetails'
        ],

        playlistId: uploads,

        maxResults: 50,

        pageToken
      });

    ids.push(
      ...(response.data.items || [])
        .map(
          (item) =>
            item.contentDetails
              .videoId
        )
    );

    pageToken =
      response.data.nextPageToken;

  } while (pageToken);

  const videos = [];

  for (
    let i = 0;
    i < ids.length;
    i += 50
  ) {
    const response =
      await yt().videos.list({
        part: [
          'snippet',
          'status',
          'statistics',
          'contentDetails'
        ],

        id: ids.slice(
          i,
          i + 50
        )
      });

    videos.push(
      ...(response.data.items ||
        [])
    );
  }

  return videos;
}

// =====================================================
// VIDEO PERFORMANCE
// =====================================================

function ageHours(iso) {
  return (
    Date.now() -
    new Date(iso).getTime()
  ) / 36e5;
}

function scoreVideo(video) {
  const hours = Math.max(
    1,
    ageHours(
      video.snippet.publishedAt
    )
  );

  const views =
    Number(
      video.statistics
        ?.viewCount || 0
    );

  const likes =
    Number(
      video.statistics
        ?.likeCount || 0
    );

  const comments =
    Number(
      video.statistics
        ?.commentCount || 0
    );

  return (
    views / hours +
    likes * 2 / hours +
    comments * 3 / hours
  );
}

// =====================================================
// BEST POSTING HOURS
// =====================================================

function bestHours(videos) {
  const publicVideos =
    videos
      .filter(
        (video) =>
          video.status
            .privacyStatus ===
            'public' &&
          video.snippet
            .publishedAt
      )
      .map((video) => {
        const hour =
          Number(
            new Intl.DateTimeFormat(
              'en-US',
              {
                timeZone: cfg.tz,
                hour: 'numeric',
                hour12: false
              }
            ).format(
              new Date(
                video.snippet
                  .publishedAt
              )
            )
          ) % 24;

        return {
          h: hour,
          s: scoreVideo(video)
        };
      });

  const aggregate =
    new Map();

  for (
    const item of publicVideos
  ) {
    const current =
      aggregate.get(item.h) || {
        sum: 0,
        n: 0
      };

    current.sum += item.s;
    current.n++;

    aggregate.set(
      item.h,
      current
    );
  }

  const ranked =
    [...aggregate]
      .map(([h, a]) => ({
        h,
        avg: a.sum / a.n,
        n: a.n
      }))
      .sort(
        (a, b) =>
          b.avg - a.avg
      );

  const chosen = [];

  for (
    const item of ranked
  ) {
    if (
      chosen.every(
        (hour) =>
          Math.min(
            Math.abs(
              hour - item.h
            ),
            24 -
              Math.abs(
                hour - item.h
              )
          ) >= 4
      )
    ) {
      chosen.push(item.h);
    }

    if (
      chosen.length >=
      cfg.postsPerDay
    ) {
      break;
    }
  }

  const fallbacks = [
    12,
    18,
    9,
    21
  ];

  for (
    const fallback of
      fallbacks
  ) {
    if (
      chosen.length <
        cfg.postsPerDay &&
      !chosen.includes(
        fallback
      )
    ) {
      chosen.push(
        fallback
      );
    }
  }

  return chosen
    .sort(
      (a, b) => a - b
    )
    .slice(
      0,
      cfg.postsPerDay
    );
}

// =====================================================
// NEXT POSTING SLOTS
// =====================================================

function nextSlots(
  hours,
  count
) {
  const slots = [];

  const now =
    new Date();

  for (
    let day = 0;
    slots.length < count &&
    day < 60;
    day++
  ) {
    for (
      const hour of hours
    ) {
      const target =
        new Date(
          now.getTime() +
          day * 86400000
        );

      const parts =
        new Intl.DateTimeFormat(
          'en-CA',
          {
            timeZone: cfg.tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
          }
        ).formatToParts(
          target
        );

      const values =
        Object.fromEntries(
          parts.map(
            (part) => [
              part.type,
              part.value
            ]
          )
        );

      // Hawaii does not use daylight saving time.
      const slot =
        new Date(
          `${values.year}-${values.month}-${values.day}T${String(
            hour
          ).padStart(
            2,
            '0'
          )}:00:00-10:00`
        );

      if (
        slot.getTime() >
        Date.now() +
          10 * 60 * 1000
      ) {
        slots.push(slot);
      }

      if (
        slots.length >=
        count
      ) {
        break;
      }
    }
  }

  return slots;
}

// =====================================================
// AUTO-SCHEDULE PRIVATE VIDEOS
// =====================================================

async function schedulePrivateVideos() {
  const verified =
    await verifyDescription();

  if (!verified.ok) {
    return {
      scheduled: 0,
      reason:
        'Verification phrase not found in channel description'
    };
  }

  const videos =
    await allOwnedVideos();

  const privateVideos =
    videos
      .filter(
        (video) =>
          video.status
            .privacyStatus ===
            'private' &&
          !video.status
            .publishAt &&
          video.status
            .uploadStatus ===
            'processed'
      )
      .sort(
        (a, b) =>
          new Date(
            a.snippet
              .publishedAt
          ) -
          new Date(
            b.snippet
              .publishedAt
          )
      );

  const hours =
    bestHours(videos);

  const slots =
    nextSlots(
      hours,
      privateVideos.length
    );

  let scheduled = 0;

  for (
    let i = 0;
    i <
    privateVideos.length;
    i++
  ) {
    if (!slots[i]) {
      break;
    }

    const video =
      privateVideos[i];

    await yt().videos.update({
      part: ['status'],

      requestBody: {
        id: video.id,

        status: {
          privacyStatus:
            'private',

          publishAt:
            slots[
              i
            ].toISOString(),

          selfDeclaredMadeForKids:
            Boolean(
              video.status
                .selfDeclaredMadeForKids
            )
        }
      }
    });

    scheduled++;
  }

  return {
    scheduled,
    hours
  };
}

// =====================================================
// GEMINI
// =====================================================

async function gemini(
  prompt
) {
  if (!cfg.geminiKey) {
    throw new Error(
      'GEMINI_API_KEY missing'
    );
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(
      cfg.geminiModel
    )}:generateContent?key=` +
    encodeURIComponent(
      cfg.geminiKey
    );

  const response =
    await fetch(url, {
      method: 'POST',

      headers: {
        'content-type':
          'application/json'
      },

      body:
        JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ]
        })
    });

  if (!response.ok) {
    throw new Error(
      `Gemini ${response.status}: ${await response.text()}`
    );
  }

  const data =
    await response.json();

  return (
    data.candidates?.[0]
      ?.content?.parts
      ?.map(
        (part) =>
          part.text || ''
      )
      .join('')
      .trim() || ''
  );
}

// =====================================================
// COMMENTS
// =====================================================

async function classifyAndReply() {
  const verified =
    await verifyDescription();

  if (!verified.ok) {
    return {
      handled: 0,
      reason:
        'Not verified'
    };
  }

  const response =
    await yt()
      .commentThreads.list({
        part: ['snippet'],

        allThreadsRelatedToChannelId:
          verified.channel.id,

        maxResults: 50,

        order: 'time'
      });

  let handled = 0;

  for (
    const thread of
      response.data.items || []
  ) {
    const comment =
      thread.snippet
        .topLevelComment;

    const id =
      comment.id;

    const alreadyHandled =
      db.prepare(`
        SELECT 1
        FROM handled_comments
        WHERE comment_id=?
      `).get(id);

    if (
      alreadyHandled
    ) {
      continue;
    }

    const snippet =
      comment.snippet;

    if (
      snippet.authorChannelId
        ?.value ===
      verified.channel.id
    ) {
      db.prepare(`
        INSERT OR IGNORE INTO handled_comments
        (comment_id, action)
        VALUES (?,?)
      `).run(
        id,
        'own'
      );

      continue;
    }

    const commentText =
      snippet.textOriginal ||
      snippet.textDisplay ||
      '';

    const verdict =
      (
        await gemini(`
Classify this YouTube comment.

Return ONLY one word:
QUESTION
SPAM
NORMAL

A question includes requests for information even without a question mark.

Comment:
${JSON.stringify(
  commentText
)}
        `)
      )
        .trim()
        .toUpperCase();

    if (
      verdict.includes(
        'QUESTION'
      )
    ) {
      db.prepare(`
        INSERT OR IGNORE INTO questions
        (
          comment_id,
          author,
          text,
          video_id,
          created_at
        )
        VALUES (?,?,?,?,?)
      `).run(
        id,
        snippet.authorDisplayName ||
          'Unknown',
        commentText,
        thread.snippet.videoId,
        snippet.publishedAt
      );

      db.prepare(`
        INSERT OR IGNORE INTO handled_comments
        (comment_id, action)
        VALUES (?,?)
      `).run(
        id,
        'question'
      );
    } else if (
      verdict.includes(
        'SPAM'
      )
    ) {
      db.prepare(`
        INSERT OR IGNORE INTO handled_comments
        (comment_id, action)
        VALUES (?,?)
      `).run(
        id,
        'spam'
      );
    } else {
      const reply =
        await gemini(`
Write one short, friendly, positive, family-friendly YouTube reply as the creator KindCrafted.

Do not pretend to know facts not in the comment.
Do not ask a question.

Comment:
${JSON.stringify(
  commentText
)}
        `);

      await yt()
        .comments.insert({
          part: ['snippet'],

          requestBody: {
            snippet: {
              parentId: id,
              textOriginal:
                reply
            }
          }
        });

      db.prepare(`
        INSERT OR IGNORE INTO handled_comments
        (
          comment_id,
          action,
          reply
        )
        VALUES (?,?,?)
      `).run(
        id,
        'replied',
        reply
      );
    }

    handled++;
  }

  return {
    handled
  };
}

// =====================================================
// API STATUS
// =====================================================

app.get(
  '/api/status',
  async (req, res) => {
    try {
      const verified =
        await verifyDescription();

      const videos =
        await allOwnedVideos();

      const privateQueue =
        videos
          .filter(
            (video) =>
              video.status
                .privacyStatus ===
              'private'
          )
          .sort(
            (a, b) =>
              new Date(
                a.snippet
                  .publishedAt
              ) -
              new Date(
                b.snippet
                  .publishedAt
              )
          )
          .map(
            (video) => ({
              id: video.id,

              title:
                video.snippet
                  .title,

              publishAt:
                video.status
                  .publishAt ||
                null
            })
          );

      const questions =
        db.prepare(`
          SELECT *
          FROM questions
          WHERE status='pending'
          ORDER BY created_at DESC
        `).all();

      res.json({
        connected: true,

        verified:
          verified.ok,

        verificationPhrase:
          cfg.phrase,

        channel: {
          id:
            verified.channel.id,

          title:
            verified.channel
              .snippet.title,

          stats:
            verified.channel
              .statistics
        },

        bestHours:
          bestHours(videos),

        privateQueue,

        questions
      });
    } catch (error) {
      res.json({
        connected: false,
        verified: false,
        error:
          error.message
      });
    }
  }
);

// =====================================================
// MANUAL SCHEDULE
// =====================================================

app.post(
  '/api/run/schedule',
  async (req, res) => {
    try {
      res.json(
        await schedulePrivateVideos()
      );
    } catch (error) {
      console.error(
        '[schedule]',
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

// =====================================================
// MANUAL COMMENTS
// =====================================================

app.post(
  '/api/run/comments',
  async (req, res) => {
    try {
      res.json(
        await classifyAndReply()
      );
    } catch (error) {
      console.error(
        '[comments]',
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

// =====================================================
// QUESTION REPLY
// =====================================================

app.post(
  '/api/questions/:id/reply',
  async (req, res) => {
    try {
      const question =
        db.prepare(`
          SELECT *
          FROM questions
          WHERE comment_id=?
        `).get(
          req.params.id
        );

      if (!question) {
        return res
          .status(404)
          .json({
            error:
              'Question not found'
          });
      }

      const text =
        String(
          req.body.text || ''
        ).trim();

      if (!text) {
        return res
          .status(400)
          .json({
            error:
              'Reply required'
          });
      }

      await yt()
        .comments.insert({
          part: ['snippet'],

          requestBody: {
            snippet: {
              parentId:
                question.comment_id,

              textOriginal:
                text
            }
          }
        });

      db.prepare(`
        UPDATE questions
        SET status='replied'
        WHERE comment_id=?
      `).run(
        question.comment_id
      );

      res.json({
        ok: true
      });
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

// =====================================================
// IGNORE QUESTION
// =====================================================

app.post(
  '/api/questions/:id/ignore',
  (req, res) => {
    db.prepare(`
      UPDATE questions
      SET status='ignored'
      WHERE comment_id=?
    `).run(
      req.params.id
    );

    res.json({
      ok: true
    });
  }
);

// =====================================================
// HEALTH CHECK
// =====================================================

app.get(
  '/health',
  (req, res) => {
    res.json({
      ok: true,
      service:
        'KindCrafted Creator Manager'
    });
  }
);

// =====================================================
// WEBSITE
// IMPORTANT: THIS FIXES "Cannot GET /"
// =====================================================

const publicDir =
  path.join(
    __dirname,
    'public'
  );

const indexFile =
  path.join(
    publicDir,
    'index.html'
  );

console.log(
  `[website] Public directory: ${publicDir}`
);

console.log(
  `[website] index.html exists: ${fs.existsSync(
    indexFile
  )}`
);

app.use(
  express.static(
    publicDir
  )
);

app.get(
  '/',
  (req, res) => {
    if (
      !fs.existsSync(
        indexFile
      )
    ) {
      return res
        .status(500)
        .send(`
          <h1>KindCrafted Creator Manager</h1>
          <p>Server is online, but public/index.html was not found.</p>
        `);
    }

    res.sendFile(
      indexFile
    );
  }
);

// =====================================================
// AUTOMATIC CYCLE
// =====================================================

let busy = false;

async function cycle() {
  if (busy) {
    return;
  }

  busy = true;

  try {
    if (
      getKV('tokens')
    ) {
      console.log(
        '[cycle] Starting'
      );

      try {
        const scheduleResult =
          await schedulePrivateVideos();

        console.log(
          '[cycle] Schedule:',
          scheduleResult
        );
      } catch (error) {
        console.error(
          '[cycle:schedule]',
          error.message
        );
      }

      try {
        const commentResult =
          await classifyAndReply();

        console.log(
          '[cycle] Comments:',
          commentResult
        );
      } catch (error) {
        console.error(
          '[cycle:comments]',
          error.message
        );
      }
    }
  } finally {
    busy = false;
  }
}

setInterval(
  cycle,
  10 * 60 * 1000
);

setTimeout(
  cycle,
  15000
);

// =====================================================
// START SERVER
// =====================================================

app.listen(
  cfg.port,
  '0.0.0.0',
  () => {
    console.log(
      `KindCrafted Creator Manager running on ${cfg.port}`
    );

    console.log(
      `[server] Base URL: ${cfg.base}`
    );

    console.log(
      `[server] OAuth redirect: ${cfg.redirectUri}`
    );

    console.log(
      `[server] Dashboard: ${cfg.base}/`
    );
  }
);
