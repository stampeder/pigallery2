import {Config} from '../../../common/config/private/Config';
import {Brackets, SelectQueryBuilder, WhereExpression} from 'typeorm';
import {MediaEntity} from './enitites/MediaEntity';
import {DiskMangerWorker} from '../threading/DiskMangerWorker';
import {ObjectManagers} from '../ObjectManagers';
import {DatabaseType} from '../../../common/config/private/PrivateConfig';
import {SortingMethod} from '../../../common/entities/SortingMethods';
import {SQLConnection} from './SQLConnection';
import {SearchQueryDTO, SearchQueryTypes, TextSearch,} from '../../../common/entities/SearchQueryDTO';
import {DirectoryEntity} from './enitites/DirectoryEntity';
import {ParentDirectoryDTO} from '../../../common/entities/DirectoryDTO';
import * as path from 'path';
import {Utils} from '../../../common/Utils';
import {CoverPhotoDTO} from '../../../common/entities/PhotoDTO';
import {IObjectManager} from './IObjectManager';
import {Logger} from '../../Logger';
import {SearchManager} from './SearchManager';

const LOG_TAG = '[CoverManager]';

// ID is need within the backend so it can be saved to DB (ID is the external key)
export interface CoverPhotoDTOWithID extends CoverPhotoDTO {
  id: number;
}

export class CoverManager implements IObjectManager {
  private static DIRECTORY_SELECT = ['directory.name', 'directory.path'];


  public async resetCovers(): Promise<void> {
    const connection = await SQLConnection.getConnection();
    await connection
      .createQueryBuilder()
      .update(DirectoryEntity)
      .set({validCover: false})
      .execute();
  }

  public async onNewDataVersion(changedDir: ParentDirectoryDTO): Promise<void> {
    // Invalidating Album cover
    let fullPath = DiskMangerWorker.normalizeDirPath(
      path.join(changedDir.path, changedDir.name)
    );
    const query = (await SQLConnection.getConnection())
      .createQueryBuilder()
      .update(DirectoryEntity)
      .set({validCover: false});

    let i = 0;
    const root = DiskMangerWorker.pathFromRelativeDirName('.');
    while (fullPath !== root) {
      const name = DiskMangerWorker.dirName(fullPath);
      const parentPath = DiskMangerWorker.pathFromRelativeDirName(fullPath);
      fullPath = parentPath;
      ++i;
      query.orWhere(
        new Brackets((q: WhereExpression) => {
          const param: { [key: string]: string } = {};
          param['name' + i] = name;
          param['path' + i] = parentPath;
          q.where(`path = :path${i}`, param);
          q.andWhere(`name = :name${i}`, param);
        })
      );
    }

    ++i;
    query.orWhere(
      new Brackets((q: WhereExpression) => {
        const param: { [key: string]: string } = {};
        param['name' + i] = DiskMangerWorker.dirName('.');
        param['path' + i] = DiskMangerWorker.pathFromRelativeDirName('.');
        q.where(`path = :path${i}`, param);
        q.andWhere(`name = :name${i}`, param);
      })
    );

    await query.execute();
  }

  public async getAlbumCover(album: {
    searchQuery: SearchQueryDTO;
  }): Promise<CoverPhotoDTOWithID> {
    const albumQuery: Brackets = await
      ObjectManagers.getInstance().SearchManager.prepareAndBuildWhereQuery(album.searchQuery);
    const connection = await SQLConnection.getConnection();

    const coverQuery = (): SelectQueryBuilder<MediaEntity> => {
      const query = connection
        .getRepository(MediaEntity)
        .createQueryBuilder('media')
        .innerJoin('media.directory', 'directory')
        .select(['media.name', 'media.id', ...CoverManager.DIRECTORY_SELECT])
        .where(albumQuery);
      SearchManager.setSorting(query, Config.AlbumCover.Sorting);
      return query;
    };
    let coverMedia = null;
    if (
      Config.AlbumCover.SearchQuery &&
      !Utils.equalsFilter(Config.AlbumCover.SearchQuery, {
        type: SearchQueryTypes.any_text,
        text: '',
      } as TextSearch)
    ) {
      try {
        const coverFilterQuery = await
          ObjectManagers.getInstance().SearchManager.prepareAndBuildWhereQuery(Config.AlbumCover.SearchQuery);
        coverMedia = await coverQuery()
          .andWhere(coverFilterQuery)
          .limit(1)
          .getOne();
      } catch (e) {
        Logger.error('Cant get album cover using:', JSON.stringify(album.searchQuery), JSON.stringify(Config.AlbumCover.SearchQuery));
        throw e;
      }
    }

    if (!coverMedia) {
      try {
        coverMedia = await coverQuery().limit(1).getOne();
      } catch (e) {
        Logger.error('Cant get album cover using:', JSON.stringify(album.searchQuery));
        throw e;
      }
    }
    return coverMedia || null;
  }

  public async getPartialDirsWithoutCovers(): Promise<
    { id: number; name: string; path: string }[]
  > {
    const connection = await SQLConnection.getConnection();
    return await connection
      .getRepository(DirectoryEntity)
      .createQueryBuilder('directory')
      .where('directory.validCover = :validCover', {validCover: 0}) // 0 === false
      .select(['name', 'id', 'path'])
      .getRawMany();
  }

  public async setAndGetCoverForDirectory(dir: {
    id: number;
    name: string;
    path: string;
  }): Promise<CoverPhotoDTOWithID> {
    const connection = await SQLConnection.getConnection();
    const coverQuery = (): SelectQueryBuilder<MediaEntity> => {
      const query = connection
        .getRepository(MediaEntity)
        .createQueryBuilder('media')
        .innerJoin('media.directory', 'directory')
        .select(['media.name', 'media.id', ...CoverManager.DIRECTORY_SELECT])
        .where(
          new Brackets((q: WhereExpression) => {
            q.where('media.directory = :dir', {
              dir: dir.id,
            });
            if (Config.Database.type === DatabaseType.mysql) {
              q.orWhere('directory.path like :path || \'%\'', {
                path: DiskMangerWorker.pathFromParent(dir),
              });
            } else {
              q.orWhere('directory.path GLOB :path', {
                path: DiskMangerWorker.pathFromParent(dir) + '*',
              });
            }
          })
        );
      // Select from the directory if any otherwise from any subdirectories.
      // (There is no priority between subdirectories)
      query.orderBy(
        `CASE WHEN directory.id = ${dir.id} THEN 0 ELSE 1 END`,
        'ASC'
      );

      SearchManager.setSorting(query, Config.AlbumCover.Sorting);
      return query;
    };

    let coverMedia: CoverPhotoDTOWithID = null;
    if (
      Config.AlbumCover.SearchQuery &&
      !Utils.equalsFilter(Config.AlbumCover.SearchQuery, {
        type: SearchQueryTypes.any_text,
        text: '',
      } as TextSearch)
    ) {
      coverMedia = await coverQuery()
        .andWhere(
          await ObjectManagers.getInstance().SearchManager.prepareAndBuildWhereQuery(Config.AlbumCover.SearchQuery)
        )
        .limit(1)
        .getOne();
    }

    if (!coverMedia) {
      coverMedia = await coverQuery().limit(1).getOne();
    }

    // set validCover bit to true even if there is no cover (to prevent future updates)
    await connection
      .createQueryBuilder()
      .update(DirectoryEntity)
      .set({cover: coverMedia, validCover: true})
      .where('id = :dir', {
        dir: dir.id,
      })
      .execute();

    return coverMedia || null;
  }
}
