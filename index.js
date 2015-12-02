'use strict';

const config = require('./config');

const fs   = require('fs');
const path = require('path');

const iconv       = require('iconv');
const mkdirp      = require('mkdirp');
const octonode    = require('octonode');
const PDFDocument = require('pdfkit');
const winston     = require('winston');

const githubClient = octonode.client({
  username: config.get('github.username'),
  password: config.get('github.password'),
});

const githubSearch = githubClient.search();

const clampBookId = function clampBookId(id) {
  return id % config.get('gutenberg.maxId');
};

const getNextIndex = function getNextIndex(paragraph) {
  let nextIndex = 0;

  paragraph.split('').forEach(function addCharCode(char) {
    nextIndex += char.charCodeAt(0);
  });

  return nextIndex;
};

const getRateTimeout = function getRateTimeout(headers) {
  if (!headers) {
    throw new Error('Rate limit probably reached');
  }

  if (headers['x-ratelimit-remaining'] < 1) {
    const timeout = headers['x-ratelimit-reset'] * 1000 - Date.now();

    winston.log(`Waiting for ${timeout}ms`);

    return timeout;
  }

  return 0;
};

const getBookEncoding = function getBookEncoding(text) {
  const match = /Character set encoding: (.*?)$/m.exec(text);

  if (!match) {
    return 'ascii';
  }

  return match[1].toLowerCase();
};

const getBookLanguage = function getBookLanguage(text) {
  const match = /Language: (.*?)$/m.exec(text);

  if (!match) {
    return 'english';
  }

  return match[1].toLowerCase();
};

const stripGutenbergBoilerplate = function stripGutenbergBoilerplate(text) {
  let output = text.replace(
    /^[\s\S]*start\s+of\s+(th(is|e)\s+)?project\s+gutenberg.*?[\*]+/i, ''
  );

  output = output.replace(
    /[\*]*\s*end\s+of\s+(th(is|e)\s+)?project\s+gutenberg[\s\S]*$/i, ''
  );

  output = output.replace(/^\s*produced\s+by[\s\S]+?(\r\n){2,}/i, '');

  output = output.trim();

  return output;
};

const getGutenbergBookFromBlob = function getGutenbergBookFromBlob(
  repo, sha, id, callback
) {
  repo.blob(sha, function parseText(err, data, headers) {
    if (err) {
      return callback(err);
    }

    setTimeout(function getText() {
      const fullTextBuffer = new Buffer(data.content, data.encoding);

      const fullText = fullTextBuffer.toString();

      if (getBookLanguage(fullText) !== 'english') {
        return callback(
          new Error(`Book ${id} is written in an unfamiliar dialect`)
        );
      }

      const charset = getBookEncoding(fullText);

      let decodedText;

      try {
        decodedText = fullTextBuffer.toString(charset);
      } catch (er) {
        try {
          const charsetConverter = new iconv.Iconv(charset, 'utf-8');

          decodedText = charsetConverter.convert(fullTextBuffer).toString();
        } catch (e) {
          return callback(new Error(`Book ${id} seems to be illegible`));
        }
      }

      const strippedText = stripGutenbergBoilerplate(decodedText);
      const fixedText    = strippedText
        .replace(/_/g, '')
        .replace(/\+/g, '')
        .replace(/\r\n/g, '\n');

      callback(null, fixedText);
    }, getRateTimeout(headers));
  });
};

const getGutenbergBookFromRepo = function getGutenbergBookFromRepo(
  repoName, id, callback
) {
  const repo = githubClient.repo(repoName);

  repo.tree('master', function getBook(err, data, headers) {
    if (err) {
      return callback(err);
    }

    let result = data.tree.find(function isText(file) {
      return file.path === `${id}.txt`;
    });

    if (!result) {
      result = data.tree.find(function isText(file) {
        return file.path === `${id}-8.txt`;
      });
    }

    if (!result) {
      result = data.tree.find(function isText(file) {
        return file.path === `${id}-0.txt`;
      });
    }

    if (!result) {
      return callback(
        new Error(`Book ${id} should be around here somewhere...`)
      );
    }

    setTimeout(function getText() {
      getGutenbergBookFromBlob(repo, result.sha, id, callback);
    }, getRateTimeout(headers));
  });
};

const getGutenbergBook = function getGutenbergBook(id, callback) {
  githubSearch.repos(
    {
      q: `_${id}+user:GITenberg`,
    },
    function checkRateLimit(err, data, headers) {
      if (err) {
        return callback(err);
      }

      const regexp = new RegExp(`.*_${id}$`);

      const result = data.items.find(function isMatch(repo) {
        return repo.name.match(regexp);
      });

      setTimeout(function findRepo() {
        if (!result) {
          return callback(
            new Error(`Book ${id} seems to be missing from the library`)
          );
        }

        getGutenbergBookFromRepo(result.full_name, id, callback);
      }, getRateTimeout(headers));
    }
  );
};

const getParagraph = function getParagraph(text, index) {
  const paragraphs = text.split(/\n{2,}/);

  const paragraphIndex = index % paragraphs.length;

  return `${paragraphs[paragraphIndex]}\n\n`;
};

const trySimilarParagraph = function trySimilarParagraph(
  book, index, callback
) {
  const extraText = '\n';

  book.write(extraText);

  callback(index + getNextIndex(extraText));
};

const addParagraph = function addParagraph(
  book, index, count, cache, callback
) {
  if (count < 1) {
    return callback();
  }

  const retry = function retry(newIndex) {
    addParagraph(book, newIndex, count, cache, callback);
  };

  if (cache[index]) {
    return trySimilarParagraph(book, index, retry);
  }

  const bookId = clampBookId(index);

  if (config.get('gutenberg.excludes').indexOf(bookId) !== -1) {
    winston.info(`Book ${bookId} is a forbidden text`);

    return trySimilarParagraph(book, index, retry);
  }

  getGutenbergBook(bookId, function processText(err, result) {
    if (err) {
      winston.info(err.message);

      return trySimilarParagraph(book, index, retry);
    }

    winston.info(`Transcribing from book ${bookId}`);

    const paragraph = getParagraph(result, index);

    book.write(paragraph);

    cache[index] = true;

    const nextIndex = getNextIndex(paragraph);

    addParagraph(book, nextIndex, count - 1, cache, callback);
  });
};

const printBook = function printBook(inputPath, outputPath) {
  const doc = new PDFDocument();

  doc.pipe(fs.createWriteStream(outputPath));

  doc.fontSize(32);

  doc
    .font('Courier')
    .text(config.get('title'), {
      align: 'center',
    });

  doc.addPage();

  doc.fontSize(10);

  const inputStream = fs.createReadStream(inputPath);

  inputStream.on('data', function addText(chunk) {
    doc
      .font('Courier')
      .text(chunk);
  });

  inputStream.on('end', function endDoc() {
    doc.end();
  });
};

const createBook = function createBook(outputPath) {
  const tempPath = path.join(__dirname, 'tmp', 'book.txt');

  mkdirp.sync(path.dirname(outputPath));
  mkdirp.sync(path.dirname(tempPath));

  const startId = config.get('gutenberg.startId');

  const book = fs.createWriteStream(tempPath);

  const cache = {};

  addParagraph(
    book,
    startId,
    config.get('paragraphLimit'),
    cache,
    function closeBook() {
      book.end();

      printBook(tempPath, outputPath);
    }
  );
};

createBook(path.join(__dirname, 'dist', 'seed-dispersal.pdf'));
