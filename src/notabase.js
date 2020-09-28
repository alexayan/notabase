const Collection = require('./collection')
const uuidv4 = require('uuid/v4')
const utils = require('./utils')

const { getBlockHashId, getFullBlockId, getUrlPageId } = require('./utils')

const NOTION_BASE_URL = "https://www.notion.so"

class Notabase {
    constructor(options = {}) {
        this.utils = utils
        this.blockStore = {}
        this.collectionSchemaStore = {}
        this.collectionStore = {}
        const { proxy, token } = options
        // proxy > browser env + cloudflare worker
        // token > node env

        if (proxy) {
            const { url, authCode } = proxy
            // browser env
            this.url = url // cloudflare worker url
            // auth code for cloudflare worker (nobody knows but you ,same to the code that config in cf-worker)
            // without authCode you can only retrieve and cannot creat/update/delete
            this.authCode = authCode
            this.reqeust = {
                async post(path, data) {
                    let r = await fetch(`${url}${path}?body=${JSON.stringify(data)}`, {
                        method: 'GET',
                        headers: {
                            'content-type': 'application/json;charset=UTF-8',
                            'x-auth-code': authCode, // custom header
                        }
                    })
                    return await r.json()
                }
            }
        } else {
            // token node env 
            this.token = token
            let tkHeader = token ? { 'cookie': `token_v2=${token}` } : {}
            const fetch = require("node-fetch")

            // non-token browse ext env
            let credentials = !token ? { credentials: 'include' } : {}
            this.reqeust = {
                async post(path, data) {
                    let r = await fetch(`${NOTION_BASE_URL}${path}`,
                        {
                            method: 'POST',
                            headers: {
                                'accept-encoding': 'gzip, deflate',
                                'content-length': JSON.stringify(data).length,
                                'content-type': 'application/json;charset=UTF-8',
                                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.103 Safari/537.36',
                                ...tkHeader
                            },
                            body: JSON.stringify(data),
                            ...credentials
                        })
                    return await r.json()
                }
            }
        }
    }


    genId() {
        return uuidv4()
    }
    async searchBlocks(fullTableID, query) {
        let data = await this.reqeust.post(`/api/v3/searchBlocks`, {
            "query": query,
            "table": "block",
            "id": fullTableID,
            "limit": 20
        })
        return data
    }
    async getBrowseableUrlByCollectionPageId(pageId) {
        let r = await this.getRecordValues([pageId], [])
        let viewId = r[0].value[pageId].view_ids[0]

        let browseableUrl = `${NOTION_BASE_URL}${getBlockHashId(pageId)}?v=${getBlockHashId(viewId)}`
        return browseableUrl
    }

    async getRecordValues(blockIds, collectionIds) {
        let requestsIds = [...blockIds.map(item => ({ "table": "block", "id": item })), ...collectionIds.map(item => ({ "table": "collection", "id": item }))]
        requestsIds.length > 10 ? console.log(`>>>> getRecordValues: ${requestsIds.length}`) : console.log(`>>>> getRecordValues:${requestsIds}`)
        let data = await this.reqeust.post(`/api/v3/getRecordValues`,
            {
                requests: requestsIds
            })
        return data.results
    }

    async loadPageChunk(pageId) {
        let data = await this.reqeust.post(`/api/v3/loadPageChunk`,
            { "pageId": getFullBlockId(pageId), "limit": 50, "cursor": { "stack": [] }, "chunkNumber": 0, "verticalColumns": false }
        )
    }
    async getPageCollectionInfo(pageId, cId) {
        console.log(`>>>> getPageChunk:${pageId} ${cId}`)
        let data = await this.reqeust.post(`/api/v3/loadPageChunk`,
            { "pageId": getFullBlockId(pageId), "limit": 50, "cursor": { "stack": [] }, "chunkNumber": 0, "verticalColumns": false }
        )
        let collectionId = Object.entries(data.recordMap.collection)[0][0]
        let collectionViewId = Object.entries(data.recordMap.collection_view)[0][0];
        const key = Object.keys(data.recordMap.collection_view).find((key) => {
            return key.replace(/-/g, '') === cId;
        })
        if (key) {
            collectionViewId = key;
        }
        const collection = data.recordMap.collection_view[collectionViewId];
        return [collectionId, collectionViewId, collection.value.query2]
    }

    async queryCollection(collectionId, collectionViewId, limit = 980, query2) {
        return await this.reqeust.post(`/api/v3/queryCollection`, {
            collectionId,
            collectionViewId,
            loader: {
                "type": "table",
                "limit": limit,
                "userTimeZone": "Asia/Shanghai",
                "userLocale": "zh-tw",
                "loadContentCover": true
            },
            query: query2
        })
    }

    async fetchCollectionData(collectionId, collectionViewId, limit = 980, query2) {
        let data = await this.queryCollection(collectionId, collectionViewId, limit, query2);
        console.log(`>>>> queryCollection:${collectionId} ${collectionViewId}`)
        // prefetch relation  data 
        /**
         * when limit > 1000, notion wont return recordMap. 
         * we need use getRecordValues fetch data piece by piece
         * 70 blocks/req 
         * 70*14 = 980 < 1000
         */
        let schema = data.recordMap.collection[collectionId].value.schema
        this.collectionSchemaStore[collectionId] = schema
        return await new Collection(collectionId, collectionViewId, data, this)
    }
    async fetch(urlOrPageId, collectionViewId) {
        let collectionId, pageId, query2;
        if (urlOrPageId.match("^[a-zA-Z0-9-]+$")) {
            // pageId with '-' split
            // pageId = getBlockHashId(urlOrPageId)
            [collectionId, collectionViewId] = await this.getPageCollectionInfo(getBlockHashId(urlOrPageId), collectionViewId)
        } else if (urlOrPageId.startsWith("http")) {
            // url 
            // pageId = getUrlPageId(urlOrPageId)
            let [base, params] = urlOrPageId.split('?')
            let baseUrlList = base.split('/'); // 这里需要添加分号，否则编译出错。 参见 https://www.zhihu.com/question/20298345/answer/49551142
            // extra collectionViewId
            const query = utils.parseQueryString(params);
            [collectionId, collectionViewId, query2] = await this.getPageCollectionInfo(baseUrlList[baseUrlList.length - 1], query.v)
        }
        let r = await this.fetchCollectionData(collectionId, collectionViewId, undefined, query2);
        // this.collectionStore[pageId] = r
        return r
    }

    async fetchAll(dbMap) {
        let db = {}
        let requests = Object.entries(dbMap).map(item => {
            let [tableName, url] = item
            db[tableName] = {}
            return this.fetch(url)
        })
        let res = await Promise.all(requests)
        Object.entries(dbMap).map((item, index) => {
            let [tableName, url] = item
            db[tableName] = res[index]
        })
        return db
    }
    async fetchConfig(url, { key, value }) {
        let dbMap = {}
        let config = await this.fetch(url)
        config.rows.map(r => {
            dbMap[r[key]] = r._raw.properties[config.propsKeyMap[value].key][0][1][0][1]
        })
        return dbMap
    }
}

module.exports = Notabase