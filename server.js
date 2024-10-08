//EXPRESS SERVER ---------------------------------------------------------------------------
const express = require('express');
const app = express();
const pug = require('pug');
const path = require('path');
const PORT = process.env.PORT || 3000;
const mc = require("mongodb").MongoClient;
const mongoURL = 'mongodb://127.0.0.1:27017';
const Crawler = require("crawler");
const { MongoClient, ObjectID } = require("mongodb");
const { Matrix } = require("ml-matrix");
const URL = require('url').URL;
const elasticlunr = require("elasticlunr");
app.set('view engine', 'pug');
app.set('views', path.join(__dirname, 'views'));

//MIDDLEWARE SEQUENCE ----------------------------------------------------------------------
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

//GLOBAL VARIABLES -------------------------------------------------------------------------
let shouldStopCrawling = false;

//CRAWLER for fruits websites---------------------------------------------------------------
function crawlFruitsWebsites() {
    const visitedURLs = new Set();

    const c = new Crawler({
        maxConnections: 10,
        jQuery: true,
        // rateLimit: 1000, 
        // retries: 3, 
        // retryTimeout: 5000,
        //This will be called for each crawled page
        callback: function (error, res, done) {
            if (error) {
                console.log(error);
            }

            if (res.$) {
                const currentURL = res.request.uri.href;

                let $ = res.$;
                const linkedTo = [];
                const title = $("title").text();
                const anchorTexts = $("a").map(function () { return $(this).text(); }).get().join(', ');
                const paragraphText = $("p").text();
                const bodyText = $("body").text();

                let links = $("a");
                $(links).each(function (i, link) {
                    const href = $(link).attr('href');
                    const fullURL = new URL(href, res.request.uri.href).toString();
                    linkedTo.push(fullURL);
                    if (!visitedURLs.has(fullURL)) {
                        visitedURLs.add(fullURL);
                        c.queue(fullURL);
                    }
                });

                //save pages only ending with .html
                if (currentURL.endsWith(".html")) {
                    //Save page contents
                    (async function savePages() {
                        const { client, db } = await connectToDatabase();

                        if (await db.collection("pages").countDocuments({ 'title': title }) == 0) {
                            //Store the content from each page within a database.
                            await db.collection("pages").insertOne({
                                title: title,
                                href: res.request.uri.href,
                                a: anchorTexts,
                                p: paragraphText,
                                body: bodyText,
                                //outgoing links from this page
                                linksTo: linkedTo,
                            });
                        }
                        closeDatabaseConnection(client);

                    })();
                }
            }
            done();
        }
    });

    c.on('drain', function () {
        console.log("Done.");
        console.log(visitedURLs.size + " Websites in Database...");
    });

    //Queue a URL, which starts the crawl
    c.queue('https://people.scs.carleton.ca/~davidmckenney/fruitgraph/N-0.html');
}

//CRAWLER for Wiki website -----------------------------------------------------------------
function crawlWikipedia() {
    const visitedURLs = new Set();
    let countDocuments = 0; // Counter to keep track of the inserted documents

    const c = new Crawler({
        maxConnections: 10,
        jQuery: true,
        callback: async function (error, res, done) {
            if (error) {
                console.log(error);
                done();
                return;
            }

            if (!shouldStopCrawling && res.$) {
                const $ = res.$;
                const currentURL = res.request.uri.href;

                console.log(`Crawling ${currentURL}`);
                if (!currentURL.startsWith('https://en.wikipedia.org/')) {
                    done();
                    console.log('Not a Wikipedia page, skipping...');
                    return;
                }

                const title = $("title").text();
                //console.log(`Title: ${title}`);
                const anchorTexts = $("a").map(function () { return $(this).text(); }).get().join(', ');
                const paragraphText = $("p").text();
                const bodyText = $("body").text();

                let links = $("a[href^='/wiki/']:not([href*=':'])");
                const linkedTo = [];

                $(links).each(function (i, link) {
                    const href = $(link).attr('href');
                    const fullURL = new URL(href, 'https://en.wikipedia.org/').toString();
                    linkedTo.push(fullURL);
                    if (!shouldStopCrawling && !visitedURLs.has(fullURL)) {
                        visitedURLs.add(fullURL);
                        c.queue(fullURL);
                    }
                });

                if (countDocuments < 750) {
                    const { client, db } = await connectToDatabase();

                    if (await db.collection("wikiPages").countDocuments({ 'title': title }) == 0) {
                        //console.log(`Inserting title: ${title}`);
                        await db.collection("wikiPages").insertOne({
                            title: title,
                            href: currentURL,
                            a: anchorTexts,
                            p: paragraphText,
                            body: bodyText,
                            linksTo: linkedTo,
                        });
                        countDocuments++;
                    }

                    closeDatabaseConnection(client);

                    if (countDocuments >= 750) {
                        shouldStopCrawling = true; 
                        c.queue = []; 
                        console.log("Limiting documents for Wiki crawl... stopping crawler.");
                    }
                }
            }
            done(); 
        }
    });

    c.on('drain', function () {
        console.log("Done.");
        console.log(countDocuments + " Wikipedia pages inserted into the database.");
    });

    // Start crawling from the Wikipedia main page
    c.queue('https://en.wikipedia.org/wiki/Main_Page');
}

//CRAWL SEQUENCE ---------------------------------------------------------------------------
crawlWikipedia();
crawlFruitsWebsites();

//FUNCTIONS --------------------------------------------------------------------------------

//connect to the database
async function connectToDatabase() {
    try {
        const client = await MongoClient.connect("mongodb://127.0.0.1:27017");
        const db = client.db('A1');
        return { client, db };
    } catch (err) {
        console.error("Failed to connect to database.", err);
        throw err;
    }
}

//close the database connection
async function closeDatabaseConnection(client) {
    try {
        await client.close();
        // console.log("Database connection closed.");
    } catch (err) {
        console.error("Failed to close database connection.", err);
        throw err;
    }
}

//function to compute the page rank
async function computeAdjacencyMatrix(collection) {
    const { client, db } = await connectToDatabase();
    const pages = await db.collection(collection).find().toArray();
    closeDatabaseConnection(client);
    const pageIndices = {};
    const matrix = Array(pages.length).fill(0).map(row => Array(pages.length).fill(0));
    pages.forEach((page, index) => {
        pageIndices[page.href] = index;
    });
    pages.forEach(page => {
        const pageIndex = pageIndices[page.href];
        page.linksTo.forEach(link => {
            const linkedPageIndex = pageIndices[link];
            if (linkedPageIndex !== undefined) {
                matrix[pageIndex][linkedPageIndex] = 1;
            }
        });
    });
    // console.log(matrix);
    return matrix;
}

//compute page rank from adjacency matrix
function computePageRankFromAdjMatrix(matrix) {
    const alpha = 0.1;
    const numberOfPages = matrix.length;
    let rank = Array(numberOfPages).fill(1.0 / numberOfPages);
    let prevRank = Array(numberOfPages).fill(0);
    const L1Difference = (v1, v2) => { return v1.reduce((sum, a, idx) => sum + Math.abs(a - v2[idx]), 0); };
    while (L1Difference(rank, prevRank) > 0.0001) {
        prevRank = [...rank];
        for (let i = 0; i < numberOfPages; i++) {
            let sum = 0;
            for (let j = 0; j < numberOfPages; j++) {
                if (matrix[j][i] === 1) {
                    const outLinks = matrix[j].reduce((acc, val) => acc + val, 0);
                    sum += prevRank[j] / outLinks;
                }
            }
            rank[i] = alpha / numberOfPages + (1 - alpha) * sum;
        }
    }
    // console.log(rank);
    return rank;
}

//ROUTES -----------------------------------------------------------------------------------

//index page
app.get('/', (req, res) => {
    res.send(pug.renderFile("./views/index.pug"));
});

//fruits search page
app.get('/fruitsSearch', (req, res) => {
    res.send(pug.renderFile("./views/fruitsSearch.pug"));
});

//wiki search page
app.get('/wikiSearch', (req, res) => {
    res.send(pug.renderFile("./views/wikiSearch.pug"));
});

//fruits result page
//fruits?q=banana&boost=true&limit=10
app.get('/fruits', (req, res) => {

    (async () => {
        let { q, boost, limit } = req.query;
        boost = (boost === 'true');
        limit = parseInt(limit);

        const { client, db } = await connectToDatabase();
        const pagesFromDB = await db.collection('pages').find().toArray();
        // console.log(pagesFromDB);
        closeDatabaseConnection(client);
        //add PageRank in pagesFromDB
        const adjMatrixData = await computeAdjacencyMatrix("pages");
        const pageRankResults = computePageRankFromAdjMatrix(adjMatrixData);
        // console.log(pageRankResults);
        const rankedPages = pagesFromDB.map((page, index) => ({
            url: page.href,
            rank: pageRankResults[index]
        }));
        pagesFromDB.forEach((page) => {
            rankedPages.forEach((pageWithRank) => {
                if (page.href === pageWithRank.url)
                    page.rank = pageWithRank.rank;
            })
        });
        // console.log(pagesFromDB);
        console.log(`PageRank score is added...`);

        //indexing
        const index = elasticlunr(function () {
            this.addField('title');
            this.addField('p');
            this.addField('a');
            this.setRef('mongo_id');
        });

        //add the index on each page
        pagesFromDB.forEach((page) => {
            index.addDoc({
                mongo_id: page._id,
                title: page.title,
                p: page.p,
                a: page.a,
            });
        });

        const refAndSearchScores = index.search(q, {});

        //each page should not be boosted
        if (!boost) {
            //add Search Score
            pagesFromDB.forEach((page) => {
                refAndSearchScores.forEach((refAndSearchScore) => {
                    if (page._id == refAndSearchScore.ref)
                        page.score = refAndSearchScore.score;
                })
            });

        } else {//each page should be boosted with PageRank

            //add Search Score
            pagesFromDB.forEach((page) => {
                refAndSearchScores.forEach((refAndSearchScore) => {
                    if (page._id == refAndSearchScore.ref)
                        page.score = refAndSearchScore.score;
                })
            });

            pagesFromDB.forEach((page) => {
                refAndSearchScores.forEach((refAndSearchScore) => {
                    if (page._id == refAndSearchScore.ref)
                        page.score = page.score * page.rank;//boost with PageRank by multiplying two values (from Dave's answer on Discord)
                })
            });
        }

        // console.log(pagesFromDB);
        console.log(`Search Score is added...`);

        pagesFromDB.sort((a, b) => b.score - a.score);
        const pagesToClient = pagesFromDB.slice(0, limit);
        // console.log(pagesToClient);

        //Response to json request
        if (req.headers['accept'] === `application/json`) {
            let results = [];
            for (const page of pagesToClient) {
                let pageObj = {};
                pageObj['name'] = `Allan Wang, Saad Qamar, Jinwook Jung`;
                pageObj['url'] = page.href;
                pageObj['score'] = page.score;
                pageObj['title'] = page.title;
                pageObj['pr'] = page.rank;
                results.push(pageObj);
            }
            //console.log(results);
            return res.json(JSON.stringify(results));
        }

        res.send(pug.renderFile("./views/fruitsResult.pug", {
            results: pagesToClient
        }));
    })();
});

//wiki result page
//wiki?q=Monopoly&boost=true&limit=10
app.get('/personal', (req, res) => {

    (async () => {
        let { q, boost, limit } = req.query;
        boost = (boost === 'true');
        limit = parseInt(limit);

        const { client, db } = await connectToDatabase();
        const pagesFromDB = await db.collection('wikiPages').find().toArray();
        // console.log(pagesFromDB);
        closeDatabaseConnection(client);
        //add PageRank in pagesFromDB
        const adjMatrixData = await computeAdjacencyMatrix("wikiPages");
        const pageRankResults = computePageRankFromAdjMatrix(adjMatrixData);
        // console.log(pageRankResults);
        const rankedPages = pagesFromDB.map((page, index) => ({
            url: page.href,
            rank: pageRankResults[index]
        }));
        pagesFromDB.forEach((page) => {
            rankedPages.forEach((pageWithRank) => {
                if (page.href === pageWithRank.url)
                    page.rank = pageWithRank.rank;
            })
        });
        // console.log(pagesFromDB);
        console.log(`PageRank score is added...`);

        //indexing
        const index = elasticlunr(function () {
            this.addField('title');
            this.addField('p');
            this.addField('a');
            this.setRef('mongo_id');
        });

        //add the index on each page
        pagesFromDB.forEach((page) => {
            index.addDoc({
                mongo_id: page._id,
                title: page.title,
                p: page.p,
                a: page.a,
            });
        });

        const refAndSearchScores = index.search(q, {});

        //each page should not be boosted
        if (!boost) {
            //add Search Score
            pagesFromDB.forEach((page) => {
                refAndSearchScores.forEach((refAndSearchScore) => {
                    if (page._id == refAndSearchScore.ref)
                        page.score = refAndSearchScore.score;
                })
            });

        } else {//each page should be boosted with PageRank

            //add Search Score
            pagesFromDB.forEach((page) => {
                refAndSearchScores.forEach((refAndSearchScore) => {
                    if (page._id == refAndSearchScore.ref)
                        page.score = refAndSearchScore.score;
                })
            });

            pagesFromDB.forEach((page) => {
                refAndSearchScores.forEach((refAndSearchScore) => {
                    if (page._id == refAndSearchScore.ref)
                        page.score = page.score * page.rank;//boost with PageRank by multiplying two values (from Dave's answer on Discord)
                })
            });
        }

        // console.log(pagesFromDB);
        console.log(`Search Score is added...`);

        pagesFromDB.sort((a, b) => b.score - a.score);
        const pagesToClient = pagesFromDB.slice(0, limit);
        // console.log(pagesToClient);

        //Response to json request
        if (req.headers['accept'] === `application/json`) {
            let results = [];
            for (const page of pagesToClient) {
                let pageObj = {};
                pageObj['name'] = `Allan Wang, Saad Qamar, Jinwook Jung`;
                pageObj['url'] = page.href;
                pageObj['score'] = page.score;
                pageObj['title'] = page.title;
                pageObj['pr'] = page.rank;
                results.push(pageObj);
            }
            //console.log(results);
            return res.json(JSON.stringify(results));
        }

        res.send(pug.renderFile("./views/wikiResult.pug", {
            results: pagesToClient
        }));
    })();
});

//START SERVER -----------------------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});