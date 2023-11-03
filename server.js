//EXPRESS SERVER --------------------------------------------------------------------- 
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

app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});

//MIDDLEWARE SEQUENCE -----------------------------------------------------------------------------------
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

//CRAWLER for fruits websites----------------------------------------------------------------------------
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

//CRAWLER for personal websites--------------------------------------------------------------------------
function crawlWikipedia() {
    let insertionCount = 0;
    let crawlerStopped = false;
    const visitedURLs = new Set();

    const c = new Crawler({
        maxConnections: 10,
        respectRobotsTxt: true,
        callback: async function (error, res, done) {
            if (error) {
                console.error(error);
            } else {
                if (typeof res.$ === "function") {
                    const $ = res.$;
                    const title = $("title").text();

                    // Only proceed if we have not stopped the crawler
                    if (!crawlerStopped) {
                        console.log(`Inserting title: ${title}`);
                        const { client, db } = await connectToDatabase();

                        try {
                            await insertPageIntoDatabase(db, 'wikiPages', {
                                title: title,
                                url: res.request.uri.href,
                            });
                            insertionCount++;
                        } catch (error) {
                            console.error('Error inserting data into the database', error);
                        } finally {
                            await client.close();
                        }
                    }

                    // If limit is reached, set flag to true
                    if (insertionCount >= 750) {
                        crawlerStopped = true;
                        done();
                        return; // Stop further processing
                    }

                    // Queue new URLs if crawler has not stopped
                    if (!crawlerStopped) {
                        $('a').each(function () {
                            const toQueueUrl = $(this).attr('href');
                            if (toQueueUrl && !toQueueUrl.startsWith('#') && !toQueueUrl.startsWith('javascript:')) {
                                const absoluteUrl = new URL(toQueueUrl, res.request.uri.href).href;
                                if (!visitedURLs.has(absoluteUrl)) {
                                    visitedURLs.add(absoluteUrl);
                                    c.queue(absoluteUrl);
                                }
                            }
                        });
                    }
                } else {
                    // Handle non-HTML
                    console.warn('The response body was not HTML.');
                }
            }
            done();
        }
    });

    c.on('drain', function () {
        console.log("Done crawling the wiki pages.");
        console.log(visitedURLs.size + " Websites in Database...");
    });

    // Crawl from the main page
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
        // console.log("Connected to database.");
        return { client, db };
    } catch (err) {
        console.error("Failed to connect to database.", err);
        throw err;
    }
}

//insert single page into the database
async function insertPageIntoDatabase(db, collectionName, pageData) {
    try {
        await db.collection(collectionName).insertOne(pageData);
    } catch (error) {
        console.error('Error inserting data into the database', error);
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
async function computeAdjacencyMatrix() {
    const { client, db } = await connectToDatabase();
    const pages = await db.collection('pages').find().toArray();
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

//ROUTE------------------------------------------------------------------------------------------
//index page
app.get('/', (req, res) => {
    res.send(pug.renderFile("./views/index.pug"));
});

//fruits search page
app.get('/fruitsSearch', (req, res) => {
    res.send(pug.renderFile("./views/fruitsSearch.pug"));
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
        const adjMatrixData = await computeAdjacencyMatrix();
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
        if (req.headers['content-type'] == `application/json`) {
            //add group member name
            for (const page of pagesToClient) {
                //add name
                page.name = `Allan Wang, Saad Qamar, Jinwook Jung`;

                //remove key and value that doesn't need  
                delete page.a;
                delete page.p;
                delete page.linksTo;
                delete page.body;
                delete page._id;

                //change key "href" to "url"
                page['url'] = page.href;
                delete page.href;
            }
            //convert js Array to object
            const objFromArray = {};
            pagesFromDB.forEach((item, index) => {
                objFromArray[`${index + 1}`] = item;
            });
            // console.log(objFromArray);
            res.json(JSON.stringify(objFromArray));

        }

        res.send(pug.renderFile("./views/fruitsResult.pug", {
            results: pagesToClient
        }));
    })();
});

//represents a request to search the data from the fruit example
app.get('/personal', (req, res) => {

});